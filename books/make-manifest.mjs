// make-manifest.mjs — regenerate books/index.json from the files in this folder.
//
// Run it whenever you add or remove a book:
//     node books/make-manifest.mjs
//
// It lists every .epub / .txt file here. Any `title` / `author` overrides you
// added to an existing index.json are preserved (matched by file name), so you
// can hand-fix messy file names once and keep them across regenerations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(dir, "index.json");

// Preserve existing overrides keyed by file name.
const overrides = {};
if (fs.existsSync(manifestPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const b of prev.books || []) {
      if (b.file) overrides[b.file] = { title: b.title, author: b.author };
    }
  } catch {
    /* ignore malformed existing manifest */
  }
}

const files = fs
  .readdirSync(dir)
  .filter((f) => /\.(epub|txt)$/i.test(f))
  .sort((a, b) => a.localeCompare(b));

const books = files.map((file) => {
  const entry = { file };
  const o = overrides[file];
  if (o?.title) entry.title = o.title;
  if (o?.author) entry.author = o.author;
  return entry;
});

fs.writeFileSync(manifestPath, JSON.stringify({ books }, null, 2) + "\n");
console.log(`Wrote ${manifestPath} with ${books.length} book(s):`);
books.forEach((b) => console.log("  •", b.title || b.file));
