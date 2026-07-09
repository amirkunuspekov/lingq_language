// epub.js — parse an .epub (a zip of XHTML) into a plain book object:
//   { title, author, coverBlob, chapters: [{ title, text }] }
// Uses JSZip (loaded globally from a CDN <script> in index.html).

// Resolve an href relative to the directory of a base path (both zip-internal).
function resolvePath(basePath, href) {
  const baseDir = basePath.includes("/") ? basePath.replace(/\/[^/]*$/, "/") : "";
  const stack = (baseDir + href).split("/");
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
const CONTAINER = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "BODY", "SPAN", "A", "FONT"]);
const DROP = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "SVG", "IMG", "IMAGE", "FIGURE", "FIGCAPTION", "NAV", "LINK", "META", "AUDIO", "VIDEO", "IFRAME", "TABLE"]);

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// Does this HTML fragment already contain block-level markup?
function hasBlock(html) {
  return /<(p|h[1-6]|blockquote|ul|ol|li|hr)\b/i.test(html);
}

function cleanNode(node) {
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

    const inner = cleanNode(child);

    if (KEEP_INLINE[tag]) {
      if (inner.trim()) {
        const t = KEEP_INLINE[tag];
        html += `<${t}>${inner}</${t}>`;
      }
    } else if (KEEP_HEADING.has(tag)) {
      if (inner.trim()) html += `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
    } else if (KEEP_BLOCK.has(tag)) {
      if (inner.trim()) html += `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
    } else if (CONTAINER.has(tag)) {
      // Unwrap containers. If a container holds raw text (no block children),
      // wrap that text in a paragraph so paragraph spacing survives.
      html += hasBlock(inner) ? inner : inner.trim() ? `<p>${inner}</p>` : "";
    } else {
      html += inner; // unknown tag: keep its text content
    }
  }
  return html;
}

function extractHtml(doc) {
  const body = doc.body || doc.querySelector("body");
  if (!body) return "";
  return cleanNode(body).replace(/(<br>\s*){3,}/g, "<br><br>").trim();
}

export async function parseEpub(file) {
  if (typeof JSZip === "undefined") {
    throw new Error("JSZip failed to load (check your internet connection).");
  }
  const zip = await JSZip.loadAsync(file);

  // 1. container.xml -> path of the .opf package document.
  const containerXml = await zip.file("META-INF/container.xml").async("string");
  const container = parseXml(containerXml);
  const opfPath = container.querySelector("rootfile").getAttribute("full-path");

  // 2. Parse the .opf: metadata, manifest, spine.
  const opf = parseXml(await zip.file(opfPath).async("string"));

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
    const html = extractHtml(doc);
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
