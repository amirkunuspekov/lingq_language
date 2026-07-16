// library.js — the library view: a "Reading Now" hero plus a grid of book
// cover cards, Apple Books style. Handles import (button + drag/drop) and
// opening/removing books.

import { getAllBooks, deleteBook, getDict, getDictVersion } from "./storage.js";
import { importFiles } from "./import.js";

let els = null;
let onOpenBook = () => {};
// Context supplied by main.js so the library can scope to the current user and
// propagate imports/deletes to the cloud.
let ctx = {
  getOwnerId: () => null, // current user's id, or null in local-only mode
  onImported: () => {}, // (book) => push to cloud
  onDeleted: () => {}, // (id)   => remove from cloud
  afterImport: () => {}, // () => route back to the library so the book is visible
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

  // Live-filter the library as the user types.
  if (els.search) els.search.addEventListener("input", () => render());

  // Drag & drop: anywhere on the library, and on the Import screen's drop-zone.
  wireDropTarget(els.view);
  if (els.dropzone) wireDropTarget(els.dropzone);

  // Import screen's "Choose file" button reuses the one hidden <input>.
  els.chooseBtn?.addEventListener("click", () => els.fileInput.click());
}

// Accept .epub/.txt dropped onto `el`, highlighting it while a drag is over it.
function wireDropTarget(el) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", (e) => {
    if (e.target === el) el.classList.remove("drag-over");
  });
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const files = [...e.dataTransfer.files].filter((f) => /\.(epub|txt)$/i.test(f.name));
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
  // Imports started from the Import screen should land on the new book, not on
  // the (now stale-looking) Import screen.
  if (books.length) ctx.afterImport();
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

  // Search filters the "All Books" grid by title/author. The Reading Now hero is
  // the current book, so it's hidden while searching to keep results focused.
  const q = (els.search?.value || "").trim().toLowerCase();
  const searching = q.length > 0;
  const shown = searching
    ? books.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(q))
    : books;

  const hero = searching ? null : books.find((b) => b.lastOpenedAt) || books[0];
  const grid = els.grid;
  grid.innerHTML = "";

  try {
    renderHero(hero);
  } catch (err) {
    console.error("Library render: hero failed:", err);
    els.hero.classList.add("hidden");
    els.heroLabel?.classList.add("hidden");
  }

  // The Import screen's "Recent" list shares this data, so keep it in step —
  // it must be updated before the empty-library early return below.
  try {
    renderRecent(books);
  } catch (err) {
    console.error("Library render: recent list failed:", err);
  }

  if (books.length === 0) {
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  if (shown.length === 0) {
    const note = document.createElement("p");
    note.className = "lib-noresults";
    note.textContent = `No books match “${q}”.`;
    grid.appendChild(note);
    return;
  }

  for (const book of shown) {
    try {
      grid.appendChild(bookCard(book));
    } catch (err) {
      console.error("Library render: card failed for", book?.id, err);
    }
  }
}

// ---- Import screen's "Recent" list -----------------------------------------

const RECENT_LIMIT = 4;

// The last few books this user imported, newest first. Folder books aren't
// imports, so they're left out.
function renderRecent(books) {
  const list = els.recentList;
  if (!list) return;
  list.innerHTML = "";

  const recent = books
    .filter((b) => b.source !== "folder")
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .slice(0, RECENT_LIMIT);

  els.recentEmpty?.classList.toggle("hidden", recent.length > 0);

  for (const book of recent) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "recent-row";

    const cover = document.createElement("img");
    cover.className = "recent-cover";
    cover.src = coverUrl(book);
    cover.alt = "";

    const info = document.createElement("div");
    info.className = "recent-info";
    const title = document.createElement("span");
    title.className = "recent-title";
    title.textContent = book.title;
    const meta = document.createElement("span");
    meta.className = "recent-meta";
    meta.textContent = book.author;
    info.append(title, meta);

    row.append(cover, info);
    row.addEventListener("click", () => onOpenBook(book.id));
    list.appendChild(row);
  }
}

// Overall reading fraction (0–1) for the progress bar. Prefer the stored
// fraction (written as you read); fall back to a chapter-based estimate for
// books opened on another device before this field existed.
function readingProgress(book) {
  const loc = book.lastLocation || {};
  if (typeof loc.progress === "number") return Math.min(1, Math.max(0, loc.progress));
  const n = book.chapters?.length || 0;
  return n ? Math.min(1, (loc.chapter || 0) / n) : 0;
}

// ---- Reading stats (compact Reading Now card) ------------------------------

const WORDS_PER_MIN = 200; // average adult silent reading speed

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Flatten a book's chapters into lowercased plain text (HTML tags stripped).
// Cached per book id: the text never changes after import, and stripping a
// megabyte-scale string on every render (nav switch, search keystroke, realtime
// progress event) is far too expensive to redo.
const plainTextCache = new Map();
function bookPlainText(book) {
  if (plainTextCache.has(book.id)) return plainTextCache.get(book.id);
  const text = (book.chapters || [])
    .map((c) => (c.html ? c.html.replace(/<[^>]+>/g, " ") : c.text || ""))
    .join(" ")
    .toLowerCase();
  plainTextCache.set(book.id, text);
  return text;
}

// Total word count, cached per book id.
const wordCountCache = new Map();
function totalWords(book) {
  if (wordCountCache.has(book.id)) return wordCountCache.get(book.id);
  const m = bookPlainText(book).match(/\S+/g);
  const n = m ? m.length : 0;
  wordCountCache.set(book.id, n);
  return n;
}

// How many of the user's saved words actually occur in this book. One pass with
// the same Unicode-aware whole-word matcher the reader uses. Keyed on the
// dictionary's version rather than its size — a delete+add replacement leaves the
// size unchanged and would otherwise serve a stale count until reload.
const savedInBookCache = new Map();
function savedWordsInBook(book) {
  const words = Object.keys(getDict());
  if (!words.length) return 0;
  const key = `${book.id}:${getDictVersion()}`;
  if (savedInBookCache.has(key)) return savedInBookCache.get(key);

  const text = bookPlainText(book);
  const alt = words.map(escapeRegex).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${alt})(?![\\p{L}\\p{N}])`, "giu");
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1]);
  savedInBookCache.set(key, found.size);
  return found.size;
}

// "~12 min left · 47 words saved" — reading time from remaining words, plus how
// many saved words appear in the book.
function heroStats(book, started) {
  const parts = [];
  const total = totalWords(book);
  if (total > 0) {
    const remaining = started ? total * (1 - readingProgress(book)) : total;
    const mins = Math.max(1, Math.round(remaining / WORDS_PER_MIN));
    parts.push(started ? `~${mins} min left` : `~${mins} min`);
  }
  const saved = savedWordsInBook(book);
  if (saved > 0) parts.push(`${saved} word${saved === 1 ? "" : "s"} saved`);
  return parts.join(" · ");
}

// Compact, fully-tappable "Reading Now" card (design's Weiterlesen). The label
// above it ("Continue Reading") is a separate section heading.
function renderHero(book) {
  const labelEl = els.heroLabel;
  if (!book) {
    els.hero.classList.add("hidden");
    labelEl?.classList.add("hidden");
    return;
  }
  const started = !!book.lastOpenedAt;
  els.hero.classList.remove("hidden");
  if (labelEl) {
    labelEl.textContent = started ? "Continue Reading" : "Start Reading";
    labelEl.classList.remove("hidden");
  }
  els.hero.innerHTML = "";

  const cover = document.createElement("img");
  cover.className = "hero-cover";
  cover.src = coverUrl(book);
  cover.alt = book.title;

  const info = document.createElement("div");
  info.className = "hero-info";

  const title = document.createElement("h2");
  title.className = "hero-title";
  title.textContent = book.title;

  const author = document.createElement("p");
  author.className = "hero-author";
  author.textContent = book.author;
  info.append(title, author);

  if (started) {
    const pct = Math.round(readingProgress(book) * 100);
    const prog = document.createElement("div");
    prog.className = "hero-progress";
    prog.innerHTML = `<div class="hero-progress-track"><div class="hero-progress-fill" style="width:${pct}%"></div></div><span class="hero-progress-pct">${pct}%</span>`;
    info.appendChild(prog);
  }

  const stats = heroStats(book, started);
  if (stats) {
    const s = document.createElement("p");
    s.className = "hero-stats";
    s.textContent = stats;
    info.appendChild(s);
  }

  els.hero.append(cover, info);
  els.hero.onclick = () => onOpenBook(book.id);
}

// Remove a book from the library (local + cloud). Shared by the ⋯ menu and the
// desktop right-click path.
async function removeBook(book) {
  if (book.source === "folder") {
    alert(
      `“${book.title}” is managed by the books/ folder.\n` +
        `To remove it, delete its file from books/ and update books/index.json.`,
    );
    return;
  }
  if (!confirm(`Remove “${book.title}” from your library?`)) return;
  await deleteBook(book.id);
  if (book.owner) ctx.onDeleted(book.id); // soft-delete in the cloud too
  await render();
}

// A tiny floating menu anchored to a card's ⋯ button. Only one is open at a
// time. Lives on <body> so the cover's `overflow:hidden` can't clip it.
let cardMenuEl = null;
function closeCardMenu() {
  if (cardMenuEl) cardMenuEl.remove();
  cardMenuEl = null;
  document.removeEventListener("click", closeCardMenu, true);
  window.removeEventListener("resize", closeCardMenu);
}
function openCardMenu(anchor, book) {
  closeCardMenu();
  const menu = document.createElement("div");
  menu.className = "card-menu";

  const del = document.createElement("button");
  del.type = "button";
  del.className = "card-menu-item danger";
  del.textContent = "Delete";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    closeCardMenu();
    await removeBook(book);
  });
  menu.appendChild(del);

  document.body.appendChild(menu);
  cardMenuEl = menu;

  // Position under the button, kept within the viewport.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let left = r.right - mw;
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${left}px`;

  // Dismiss on any outside click (next tick so this opening click doesn't close
  // it) or on resize.
  setTimeout(() => document.addEventListener("click", closeCardMenu, true), 0);
  window.addEventListener("resize", closeCardMenu);
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

  // ⋯ options button (primary delete path on touch, where there's no right-click).
  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "book-menu-btn";
  menuBtn.textContent = "⋯";
  menuBtn.setAttribute("aria-label", "Book options");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't open the book
    openCardMenu(menuBtn, book);
  });
  shelf.appendChild(menuBtn);

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
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    removeBook(book);
  });
  return card;
}

