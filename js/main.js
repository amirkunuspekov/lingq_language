// main.js — bootstrap: gather DOM references, wire the three views
// (library, word list, reader) and route between them.

import {
  initLibrary,
  render as renderLibrary,
  setLibraryContext,
} from "./library.js";
import { initReader, openBook, refreshHighlights } from "./reader.js";
import { initWordList, render as renderWordList } from "./dictionary.js";
import { initContextMenu } from "./contextmenu.js";
import { loadFolderBooks } from "./folder.js";
import { initSync } from "./sync.js";
import { initAuth } from "./auth.js";
import { setActiveUser } from "./storage.js";
import {
  pullBooks,
  uploadBook,
  deleteBookRemote,
  initBooksRealtime,
} from "./booksync.js";

const $ = (id) => document.getElementById(id);

// ---- Views / routing -------------------------------------------------------

const libraryView = $("library-view");
const wordlistView = $("wordlist-view");
const readerView = $("reader-view");
const sidebar = $("sidebar");

function showMain(view) {
  // Library and Word List share the sidebar layout; the reader is fullscreen.
  readerView.classList.add("hidden");
  sidebar.classList.remove("hidden");
  libraryView.classList.toggle("hidden", view !== "library");
  wordlistView.classList.toggle("hidden", view !== "wordlist");
  $("nav-library").classList.toggle("active", view === "library");
  $("nav-wordlist").classList.toggle("active", view === "wordlist");
  if (view === "wordlist") renderWordList();
  if (view === "library") renderLibrary();
}

function showReader() {
  libraryView.classList.add("hidden");
  wordlistView.classList.add("hidden");
  sidebar.classList.add("hidden");
  readerView.classList.remove("hidden");
}

// ---- Wire modules ----------------------------------------------------------

// When the dictionary changes anywhere, re-apply reader highlights and refresh
// the word list so both stay in sync.
function onDictChange() {
  refreshHighlights();
  renderWordList();
}

initLibrary(
  {
    view: libraryView,
    grid: $("book-grid"),
    hero: $("reading-now"),
    heroLabel: $("reading-now-label"),
    search: $("library-search"),
    emptyState: $("library-empty"),
    importBtn: $("import-btn"),
    fileInput: $("file-input"),
  },
  async (id) => {
    showReader(); // reveal first so the reader viewport can be measured
    await openBook(id);
  },
);

initReader(
  {
    view: readerView,
    overlay: $("overlay"), // shown behind the translation modal; suppresses reader keys
    viewport: $("page-viewport"),
    bookText: $("book-text"),
    title: $("reader-title"),
    chapterLabel: $("reader-chapter"),
    pageCount: $("page-count"),
    progressFill: $("reader-progress-fill"),
    flipForward: $("flip-forward"),
    flipBackward: $("flip-backward"),
    back: $("reader-back"),
    contentsPanel: $("contents-panel"),
    contentsList: $("contents-list"),
  },
  () => showMain("library"),
);

initWordList(
  {
    search: $("wl-search"),
    tbody: $("wl-tbody"),
    table: $("wl-table"),
    empty: $("wl-empty"),
    count: $("wl-count"),
    exportBtn: $("wl-export"),
    addForm: $("wl-add-form"),
    addWord: $("wl-add-word"),
    addTrans: $("wl-add-trans"),
  },
  onDictChange,
);

initContextMenu(
  {
    reader: $("reader-view"),
    bookText: $("book-text"),
    menu: $("ctx-menu"),
    popover: $("translation-popover"),
    selToolbar: $("sel-toolbar"),
    overlay: $("overlay"),
    modal: $("translation-modal"),
    modalWord: $("modal-word"),
    modalInput: $("modal-input"),
    modalSave: $("modal-save"),
  },
  onDictChange,
);

// ---- Nav + misc ------------------------------------------------------------

$("nav-library").addEventListener("click", () => showMain("library"));
$("nav-wordlist").addEventListener("click", () => showMain("wordlist"));

// Contents (table of contents) panel toggle inside the reader.
$("reader-contents").addEventListener("click", () => {
  $("contents-panel").classList.toggle("hidden");
});
$("contents-close")?.addEventListener("click", () => {
  $("contents-panel").classList.add("hidden");
});

// Appearance (theme) cycle: light -> sepia -> dark.
const THEMES = ["light", "sepia", "dark"];
$("reader-aa").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "light";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
});
document.documentElement.dataset.theme = localStorage.getItem("theme") || "light";

// Give the library the current-user context so imports/deletes reach the cloud.
setLibraryContext({
  getOwnerId: () => currentUser?.id || null,
  onImported: (book) => uploadBook(book),
  onDeleted: (id) => deleteBookRemote(id),
});

let currentUser = null;

// Start the app for a signed-in user (or null in local-only mode). Runs once
// per session; sign-out reloads the page, which is the reliable teardown.
async function startApp(user) {
  currentUser = user;
  setActiveUser(user?.id || null); // scope the dictionary cache to this user

  showMain("library"); // shows cached books immediately

  // Shared folder shelf (always), then the user's own cloud books.
  await loadFolderBooks().catch((e) => console.error("Folder load failed:", e));
  if (user) {
    await pullBooks(user.id, renderLibrary).catch((e) =>
      console.error("Book pull failed:", e),
    );
  }
  renderLibrary();

  // Cross-device sync for words + reading position (scoped to this user by RLS).
  await initSync({
    onDictChange,
    onProgressChange: () => renderLibrary(),
  });
  if (user) initBooksRealtime(user.id, renderLibrary);
}

// ---- Stale-tab refresh (iPhone Safari) -------------------------------------
// Safari keeps a backgrounded tab frozen instead of reloading it, so when the
// user returns after reading on another device the reader still shows the old
// position and the realtime socket is dead. If the tab has been hidden for 5+
// minutes, reload on return: this tears down the stale state, re-pulls the
// synced reading position, and lands the user back on the library (book closed).
const STALE_AFTER_MS = 5 * 60 * 1000;
let hiddenAt = 0;

function markHidden() {
  if (hiddenAt === 0) hiddenAt = Date.now();
}

function refreshIfStale() {
  if (hiddenAt && Date.now() - hiddenAt >= STALE_AFTER_MS) {
    location.reload();
    return;
  }
  hiddenAt = 0;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) markHidden();
  else refreshIfStale();
});

// Safari restores a frozen/bfcached tab via pagehide/pageshow rather than a
// fresh load, so cover those events too.
window.addEventListener("pagehide", markHidden);
window.addEventListener("pageshow", refreshIfStale);

// Auth gate: if Supabase is configured, this shows a login screen and calls
// startApp once signed in; otherwise it calls startApp(null) immediately.
initAuth({
  onAuth: (user) => startApp(user),
  onSignOut: () => location.reload(),
});
