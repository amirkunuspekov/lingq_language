// library.js — the library view: a "Reading Now" hero plus a grid of book
// cover cards, Apple Books style. Handles import (button + drag/drop) and
// opening/removing books.

import { getAllBooks, deleteBook } from "./storage.js";
import { importFiles } from "./import.js";

let els = null;
let onOpenBook = () => {};
// Context supplied by main.js so the library can scope to the current user and
// propagate imports/deletes to the cloud.
let ctx = {
  getOwnerId: () => null, // current user's id, or null in local-only mode
  onImported: () => {}, // (book) => push to cloud
  onDeleted: () => {}, // (id)   => remove from cloud
};

export function setLibraryContext(context) {
  ctx = { ...ctx, ...context };
}

export function initLibrary(refs, openBookCallback) {
  els = refs;
  onOpenBook = openBookCallback;

  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await handleImport(files);
  });

  // Drag & drop anywhere on the library.
  els.view.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.view.classList.add("drag-over");
  });
  els.view.addEventListener("dragleave", (e) => {
    if (e.target === els.view) els.view.classList.remove("drag-over");
  });
  els.view.addEventListener("drop", async (e) => {
    e.preventDefault();
    els.view.classList.remove("drag-over");
    const files = [...e.dataTransfer.files].filter((f) =>
      /\.(epub|txt)$/i.test(f.name),
    );
    await handleImport(files);
  });
}

async function handleImport(files) {
  if (!files.length) return;
  const owner = ctx.getOwnerId();
  const books = await importFiles(files, { owner });
  // Push each new book to the user's cloud library (no-op when local-only).
  if (owner) for (const book of books) ctx.onImported(book);
  await render();
}

// Cover is stored as a data-URL string on the book — use it directly.
// Legacy fallback: books imported before the string-cover change still carry a
// Blob; wrap it in an object URL so they keep showing (re-import to fully fix).
function coverUrl(book) {
  if (book.cover) return book.cover;
  if (book.coverBlob) return URL.createObjectURL(book.coverBlob);
  return "";
}

// Which books to show: the shared folder shelf, plus books owned by the current
// user. When logged out (local mode), show folder books and un-owned local ones.
function visibleTo(book, ownerId) {
  if (book.source === "folder") return true;
  if (ownerId) return book.owner === ownerId;
  return !book.owner; // local-only: hide any user-owned books
}

export async function render() {
  const ownerId = ctx.getOwnerId();

  let books = [];
  try {
    const all = await getAllBooks();
    // Defensive: skip records that are malformed (e.g. a partial/legacy row with
    // no chapters). A single bad record must never blank the whole library —
    // before this guard, such a record threw in renderHero and left the page
    // silently empty (no cards, not even the empty state).
    books = all.filter((b) => b && Array.isArray(b.chapters) && visibleTo(b, ownerId));
  } catch (err) {
    console.error("Library render: getAllBooks failed:", err);
  }

  // Reading Now hero = most recently opened book (if any).
  const hero = books.find((b) => b.lastOpenedAt) || books[0];
  const grid = els.grid;
  grid.innerHTML = "";

  try {
    renderHero(hero, books.length);
  } catch (err) {
    console.error("Library render: hero failed:", err);
    els.hero.classList.add("hidden");
  }

  if (books.length === 0) {
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  for (const book of books) {
    try {
      grid.appendChild(bookCard(book));
    } catch (err) {
      console.error("Library render: card failed for", book?.id, err);
    }
  }
}

function renderHero(book, total) {
  if (!book) {
    els.hero.classList.add("hidden");
    return;
  }
  els.hero.classList.remove("hidden");
  const progress = book.lastOpenedAt ? "Continue Reading" : "Start Reading";
  els.hero.innerHTML = "";

  const cover = document.createElement("img");
  cover.className = "hero-cover";
  cover.src = coverUrl(book);
  cover.alt = book.title;

  const info = document.createElement("div");
  info.className = "hero-info";
  info.innerHTML = `
    <p class="hero-eyebrow">Reading Now</p>
    <h2 class="hero-title">${escapeHtml(book.title)}</h2>
    <p class="hero-author">${escapeHtml(book.author)}</p>
    <p class="hero-meta">${(book.chapters?.length ?? 0)} chapter${
      (book.chapters?.length ?? 0) === 1 ? "" : "s"
    } · ${total} book${total === 1 ? "" : "s"} in library</p>
  `;
  const btn = document.createElement("button");
  btn.className = "hero-btn";
  btn.textContent = progress;
  btn.addEventListener("click", () => onOpenBook(book.id));
  info.appendChild(btn);

  els.hero.append(cover, info);
  cover.addEventListener("click", () => onOpenBook(book.id));
}

function bookCard(book) {
  const card = document.createElement("div");
  card.className = "book-card";
  card.tabIndex = 0;

  const shelf = document.createElement("div");
  shelf.className = "book-cover-wrap";
  const img = document.createElement("img");
  img.className = "book-cover";
  img.src = coverUrl(book);
  img.alt = book.title;
  shelf.appendChild(img);

  const title = document.createElement("div");
  title.className = "book-card-title";
  title.textContent = book.title;

  const author = document.createElement("div");
  author.className = "book-card-author";
  author.textContent = book.author;

  card.append(shelf, title, author);
  card.addEventListener("click", () => onOpenBook(book.id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onOpenBook(book.id);
  });
  card.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (book.source === "folder") {
      alert(
        `“${book.title}” is managed by the books/ folder.\n` +
          `To remove it, delete its file from books/ and update books/index.json.`,
      );
      return;
    }
    if (confirm(`Remove “${book.title}” from your library?`)) {
      await deleteBook(book.id);
      if (book.owner) ctx.onDeleted(book.id); // remove from cloud too
      await render();
    }
  });
  return card;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
