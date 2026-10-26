// folder.js — load books that ship with the app in the committed `books/`
// folder. The folder can't be listed over HTTP (works on GitHub Pages too), so
// a small `books/index.json` manifest names the files. Parsed books are cached
// in IndexedDB under a stable `folder:<file>` id, so they load instantly on
// later visits and keep their own reading position per device.

import { parseToBook } from "./import.js";
import { getBook, putBook } from "./storage.js";

const MANIFEST_URL = "books/index.json";

function folderId(fileName) {
  return "folder:" + fileName;
}

// Fetch + parse any books listed in the manifest that aren't cached yet.
// Returns the number of newly added books (so the caller can re-render).
export async function loadFolderBooks() {
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) return 0; // no manifest -> nothing to do
    manifest = await res.json();
  } catch {
    return 0; // not served / offline / malformed
  }

  const entries = Array.isArray(manifest) ? manifest : manifest.books || [];
  let added = 0;

  for (const entry of entries) {
    const fileName = typeof entry === "string" ? entry : entry.file;
    if (!fileName) continue;
    const id = folderId(fileName);

    if (await getBook(id)) continue; // already cached

    try {
      const res = await fetch("books/" + encodeURIComponent(fileName), {
        cache: "no-cache",
      });
      if (!res.ok) {
        console.warn("Folder book not found:", fileName);
        continue;
      }
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: blob.type });
      const book = await parseToBook(file, id);

      // Optional manifest overrides for nicer titles/authors (esp. for .txt).
      if (entry.title) book.title = entry.title;
      if (entry.author) book.author = entry.author;
      book.source = "folder"; // marks it as managed by the books/ folder

      await putBook(book);
      added++;
    } catch (e) {
      console.error("Failed to load folder book", fileName, e);
    }
  }

  return added;
}
