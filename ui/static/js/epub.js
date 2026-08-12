// epub.js — parse an .epub (a zip of XHTML) into a plain book object:
//   { title, author, coverBlob, chapters: [{ title, text }] }
// Uses JSZip (loaded globally from a CDN <script> in index.html).

// Percent-decode, tolerating malformed sequences (a bare "%" is not fatal).
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Resolve an href relative to the directory of a base path (both zip-internal).
// EPUB manifest hrefs are URI references, so a file named "chapter 1.xhtml" is
// legally written href="chapter%201.xhtml" — but JSZip keys entries by their raw
// name, so the lookup must be decoded first or the chapter silently vanishes.
function resolvePath(basePath, href) {
  const baseDir = basePath.includes("/") ? basePath.replace(/\/[^/]*$/, "/") : "";
  const stack = safeDecode(baseDir + href).split("/");
  const out = [];
  for (const part of stack) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

// Sanitize a spine document's <body> into a whitelisted subset of HTML so the
// original formatting (headings, bold, italic, blockquotes, lists) is preserved
// and can be styled distinctly, while scripts/styles/images/attributes are
// stripped for safety and clean pagination.
const KEEP_INLINE = { B: "strong", STRONG: "strong", I: "em", EM: "em", U: "u", SUP: "sup", SUB: "sub", SMALL: "small" };
const KEEP_HEADING = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const KEEP_BLOCK = new Set(["P", "BLOCKQUOTE", "UL", "OL", "LI"]);
const BLOCK_CONTAINER = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "BODY"]);
const INLINE_CONTAINER = new Set(["SPAN", "A", "FONT"]);
const DROP = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "SVG", "IMG", "IMAGE", "FIGURE", "FIGCAPTION", "NAV", "LINK", "META", "AUDIO", "VIDEO", "IFRAME", "TABLE"]);

// Read the *appearance* an element resolves to under the EPUB's own CSS and turn
// it into a small, safe inline-style string. Only visual properties that can't
// disrupt our pagination are kept (no margins/floats/positioning). Colors are
// deliberately skipped so the reader's light/sepia/dark themes stay readable.
// `baseFont` is the chapter's base font-size in px, so sizes become relative ems
// that scale with the reader's own font size.
function safeStyle(el, baseFont) {
  let cs;
  try { cs = getComputedStyle(el); } catch { return ""; }
  const parts = [];
  const fw = cs.fontWeight;
  if (fw === "bold" || parseInt(fw, 10) >= 600) parts.push("font-weight:700");
  if (cs.fontStyle === "italic" || cs.fontStyle === "oblique") parts.push("font-style:italic");
  if (cs.textAlign === "center") parts.push("text-align:center");
  else if (cs.textAlign === "right" || cs.textAlign === "end") parts.push("text-align:right");
  const fs = parseFloat(cs.fontSize);
  if (fs && baseFont) {
    const r = fs / baseFont;
    if (r >= 1.15 || r <= 0.85) parts.push(`font-size:${r.toFixed(2)}em`);
  }
  if (cs.textTransform === "uppercase" || cs.textTransform === "capitalize") {
    parts.push(`text-transform:${cs.textTransform}`);
  }
  if (cs.fontVariant === "small-caps" || cs.fontVariantCaps === "small-caps") {
    parts.push("font-variant:small-caps");
  }
  return parts.join(";");
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// Does this HTML fragment already contain block-level markup?
function hasBlock(html) {
  return /<(p|h[1-6]|blockquote|ul|ol|li|hr)\b/i.test(html);
}

function cleanNode(node, baseFont) {
  let html = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      html += escapeHtml(child.textContent);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (tag === "BR") { html += "<br>"; continue; }
    if (tag === "HR") { html += "<hr>"; continue; }

    const inner = cleanNode(child, baseFont);
    const style = safeStyle(child, baseFont);
    const attr = style ? ` style="${style}"` : "";

    if (KEEP_INLINE[tag]) {
      if (inner.trim()) {
        const t = KEEP_INLINE[tag];
        html += `<${t}>${inner}</${t}>`;
      }
    } else if (KEEP_HEADING.has(tag) || KEEP_BLOCK.has(tag)) {
      if (inner.trim()) html += `<${tag.toLowerCase()}${attr}>${inner}</${tag.toLowerCase()}>`;
    } else if (INLINE_CONTAINER.has(tag)) {
      // Keep inline; wrap in a styled span only when it carries emphasis.
      if (inner.trim()) html += style ? `<span${attr}>${inner}</span>` : inner;
    } else if (BLOCK_CONTAINER.has(tag)) {
      // Unwrap block containers. If one holds raw text (no block children), wrap
      // that text in a paragraph so paragraph spacing (and its style) survives.
      if (hasBlock(inner)) html += inner;
      else if (inner.trim()) html += `<p${attr}>${inner}</p>`;
    } else {
      html += inner; // unknown tag: keep its text content
    }
  }
  return html;
}

// Fetch the stylesheets a spine document references (linked .css files + inline
// <style> blocks), so we can resolve its class-based styling.
async function collectCss(zip, doc, docPath) {
  let css = "";
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"], link[type="text/css"]')) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const f = zip.file(resolvePath(docPath, href));
    if (f) { try { css += (await f.async("string")) + "\n"; } catch { /* ignore */ } }
  }
  doc.querySelectorAll("style").forEach((s) => { css += s.textContent + "\n"; });
  return css;
}

// Sanitize a spine document into our whitelist, but first render it with the
// EPUB's own CSS inside a Shadow DOM so getComputedStyle resolves class-based
// styling into inline emphasis (bold/italic/size/alignment). The shadow keeps
// that CSS from leaking into the app, and resource tags are stripped so nothing
// loads. Falls back to plain sanitization if anything goes wrong.
function extractHtml(doc, css) {
  const body = doc.body || doc.querySelector("body");
  if (!body) return "";
  body
    .querySelectorAll("script,iframe,object,embed,img,image,svg,audio,video,link,meta,title,noscript,style")
    .forEach((el) => el.remove());
  // The tag list above is a denylist, and this markup is about to be mounted into
  // a live shadow root. Inline handlers on tags it doesn't cover (<details
  // ontoggle>, <input autofocus onfocus>, <marquee onstart>) would survive, so
  // strip every on* attribute rather than relying on the host being hidden.
  body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });

  let host = null;
  try {
    host = document.createElement("div");
    host.setAttribute("style", "position:absolute;left:-99999px;top:0;width:760px;visibility:hidden;");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    // Neutralize anything that could fetch (external @imports, url() fonts/images).
    const safeCss = (css || "").replace(/@import[^;]+;/gi, "").replace(/url\([^)]*\)/gi, "none");
    const styleEl = document.createElement("style");
    styleEl.textContent = safeCss;
    shadow.appendChild(styleEl);
    const mount = document.createElement("div");
    mount.innerHTML = body.innerHTML;
    shadow.appendChild(mount);

    const baseFont = parseFloat(getComputedStyle(mount).fontSize) || 16;
    const out = cleanNode(mount, baseFont);
    return out.replace(/(<br>\s*){3,}/g, "<br><br>").trim();
  } catch {
    return cleanNode(body, 16).replace(/(<br>\s*){3,}/g, "<br><br>").trim();
  } finally {
    if (host) host.remove();
  }
}

export async function parseEpub(file) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load (check your internet connection).");
  }
  const zip = await JSZip.loadAsync(file);

  // 1. container.xml -> path of the .opf package document. Each step is checked
  //    so a malformed file reports what's actually wrong instead of surfacing a
  //    "Cannot read properties of null" in the import alert.
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    throw new Error("Not a valid EPUB (missing META-INF/container.xml).");
  }
  const container = parseXml(await containerFile.async("string"));
  const rootfile = container.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) {
    throw new Error("Not a valid EPUB (container.xml has no rootfile path).");
  }

  // 2. Parse the .opf: metadata, manifest, spine.
  const opfFile = zip.file(safeDecode(opfPath));
  if (!opfFile) {
    throw new Error(`Not a valid EPUB (package file "${opfPath}" is missing).`);
  }
  const opf = parseXml(await opfFile.async("string"));

  const title =
    opf.querySelector("metadata > title, title")?.textContent?.trim() ||
    file.name.replace(/\.epub$/i, "");
  const author =
    opf.querySelector("metadata > creator, creator")?.textContent?.trim() || "Unknown";

  // manifest: id -> { href (zip-absolute), type, properties }
  const manifest = {};
  opf.querySelectorAll("manifest > item").forEach((item) => {
    manifest[item.getAttribute("id")] = {
      href: resolvePath(opfPath, item.getAttribute("href")),
      type: item.getAttribute("media-type") || "",
      properties: item.getAttribute("properties") || "",
    };
  });

  // 3. Cover: prefer manifest property cover-image, else <meta name="cover">.
  let coverBlob = null;
  let coverItem = Object.values(manifest).find((m) =>
    m.properties.includes("cover-image"),
  );
  if (!coverItem) {
    const metaCover = opf.querySelector('metadata > meta[name="cover"]');
    if (metaCover) coverItem = manifest[metaCover.getAttribute("content")];
  }
  if (coverItem && zip.file(coverItem.href)) {
    coverBlob = await zip.file(coverItem.href).async("blob");
  }

  // 4. Spine order -> chapters. Only include XHTML/HTML documents.
  const chapters = [];
  const itemrefs = opf.querySelectorAll("spine > itemref");
  for (const ref of itemrefs) {
    const item = manifest[ref.getAttribute("idref")];
    if (!item || !/html/i.test(item.type)) continue;
    const zf = zip.file(item.href);
    if (!zf) continue;
    const doc = new DOMParser().parseFromString(await zf.async("string"), "text/html");
    const css = await collectCss(zip, doc, item.href);
    const html = extractHtml(doc, css);
    if (!html || !doc.body?.textContent?.trim()) continue;
    // Chapter title: first heading if present, else a running number.
    const heading = doc.querySelector("h1, h2, h3")?.textContent?.trim();
    chapters.push({ title: heading || `Chapter ${chapters.length + 1}`, html });
  }

  if (chapters.length === 0) {
    throw new Error("No readable text found in this EPUB.");
  }

  return { title, author, format: "epub", coverBlob, chapters };
}
