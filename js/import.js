// import.js — accept .txt / .epub files, normalize into a stored book object.

import { parseEpub } from "./epub.js";
import { putBook, makeId } from "./storage.js";

// Split a big plain-text blob into chapters on common heading patterns so a
// long .txt still gets a table of contents. Falls back to a single chapter.
function splitTxtIntoChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let current = { title: "Beginning", lines: [] };
  const HEADING = /^\s*(chapter|kapitel|part|book|глава|часть)\b/i;
  for (const line of lines) {
    const trimmed = line.trim();
    // A short standalone all-caps or "Chapter"-style line starts a new chapter.
    const looksHeading =
      (HEADING.test(trimmed) && trimmed.length < 60) ||
      (trimmed.length > 0 && trimmed.length < 50 && trimmed === trimmed.toUpperCase() && /[A-ZА-Я]/.test(trimmed));
    if (looksHeading && current.lines.join("").trim().length > 200) {
      chapters.push(current);
      current = { title: trimmed, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  chapters.push(current);
  return chapters
    .map((c) => ({ title: c.title, text: c.lines.join("\n").trim() }))
    .filter((c) => c.text.length > 0)
    .map((c) => ({ title: c.title, html: textToHtml(c.text, c.title) }));
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
}

// Plain text -> HTML: blank lines separate paragraphs; single newlines become
// line breaks. The chapter's own heading line is promoted to an <h2> so txt
// chapter titles render distinctly, matching EPUB heading styling.
function textToHtml(text, title) {
  const blocks = text.split(/\n\s*\n/);
  const out = [];
  blocks.forEach((block, i) => {
    const trimmed = block.trim();
    if (!trimmed) return;
    if (i === 0 && title && trimmed.startsWith(title.trim()) && title !== "Beginning") {
      const rest = trimmed.slice(title.trim().length).trim();
      out.push(`<h2>${escapeHtml(title.trim())}</h2>`);
      if (rest) out.push(`<p>${escapeHtml(rest).replace(/\n/g, "<br>")}</p>`);
    } else {
      out.push(`<p>${escapeHtml(trimmed).replace(/\n/g, "<br>")}</p>`);
    }
  });
  return out.join("\n");
}

// Deterministic-ish accent color from a title string (no randomness needed).
function colorFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

// Draw a simple generated cover for books that ship without one.
export function generateCover(title, author) {
  const w = 300, h = 450;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const hue = colorFromString(title);
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue}, 55%, 42%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 55%, 28%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Title text, wrapped.
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.font = "600 30px Georgia, serif";
  ctx.textAlign = "center";
  const words = title.split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > w - 48 && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const startY = h / 2 - (lines.length - 1) * 20;
  lines.slice(0, 6).forEach((l, i) => ctx.fillText(l, w / 2, startY + i * 40));

  ctx.font = "italic 18px Georgia, serif";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(author || "", w / 2, h - 48);

  // Return a data URL (string) — strings survive IndexedDB round-trips on every
  // browser, unlike Blobs (Safari drops Blobs stored in IndexedDB).
  return canvas.toDataURL("image/png");
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function importTxt(file) {
  const text = await file.text();
  const title = file.name.replace(/\.txt$/i, "");
  return {
    title,
    author: "Unknown",
    format: "txt",
    coverBlob: null,
    chapters: splitTxtIntoChapters(text),
  };
}

// Import one File -> persisted book. Returns the stored book object.
export async function importFile(file) {
  const name = file.name.toLowerCase();
  let parsed;
  if (name.endsWith(".epub")) {
    parsed = await parseEpub(file);
  } else if (name.endsWith(".txt")) {
    parsed = await importTxt(file);
  } else {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  // Store the cover as a data-URL string (see generateCover for why).
  const cover = parsed.coverBlob
    ? await blobToDataURL(parsed.coverBlob)
    : generateCover(parsed.title, parsed.author);

  const book = {
    id: makeId(),
    title: parsed.title,
    author: parsed.author,
    format: parsed.format,
    cover,
    chapters: parsed.chapters,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    lastLocation: { chapter: 0, page: 0 },
  };
  await putBook(book);
  return book;
}

export async function importFiles(fileList) {
  const results = [];
  for (const file of fileList) {
    try {
      results.push(await importFile(file));
    } catch (err) {
      console.error("Import failed for", file.name, err);
      alert(`Could not import "${file.name}": ${err.message}`);
    }
  }
  return results;
}
