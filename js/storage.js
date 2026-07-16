// storage.js — persistence layer.
//   Books (potentially large, with cover blobs) live in IndexedDB.
//   The global word->translation dictionary is small, so it lives in
//   localStorage and is mirrored in memory for synchronous access during
//   rendering/highlighting.

const DB_NAME = "readingApp";
const DB_VERSION = 1;
const BOOKS_STORE = "books";
const DICT_KEY = "dictionary";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BOOKS_STORE)) {
        db.createObjectStore(BOOKS_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDB().then((db) => db.transaction(BOOKS_STORE, mode).objectStore(BOOKS_STORE));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---- Books -----------------------------------------------------------------

export async function putBook(book) {
  const store = await tx("readwrite");
  await reqToPromise(store.put(book));
  return book;
}

export async function getBook(id) {
  const store = await tx("readonly");
  return reqToPromise(store.get(id));
}

export async function getAllBooks() {
  const store = await tx("readonly");
  const all = await reqToPromise(store.getAll());
  // Most recently opened first (falls back to added time).
  return all.sort(
    (a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0),
  );
}

export async function deleteBook(id) {
  const store = await tx("readwrite");
  await reqToPromise(store.delete(id));
}

// Erase everything belonging to `ownerId` from THIS device: their cached books
// and their word list. Called on sign-out.
//
// Why this is necessary: there is one IndexedDB database for every user who has
// ever signed in on this browser, and the owner check in the library only *hides*
// other users' books. Without this purge, the next person to use the device could
// read the previous user's full book text and word list straight out of DevTools.
// Safe to delete: the cloud is the source of truth and everything re-pulls on the
// next sign-in. Folder books are shared and re-parsed from books/, so they stay.
export async function purgeLocalUserData(ownerId) {
  if (!ownerId) return;
  for (const book of await getAllBooks()) {
    if (book.source === "folder") continue;
    if (book.owner === ownerId) await deleteBook(book.id);
  }
  try {
    localStorage.removeItem(`${DICT_KEY}:${ownerId}`);
  } catch {
    /* ignore */
  }
}

// Optional push hook (installed by the sync layer) for reading position.
let progressPushFn = null;
export function setProgressPush(fn) {
  progressPushFn = fn;
}

export async function updateLocation(id, location) {
  const book = await getBook(id);
  if (!book) return;
  book.lastLocation = location;
  book.lastOpenedAt = Date.now();
  await putBook(book);
  if (progressPushFn) progressPushFn(id, location);
}

// Apply reading position that came from another device (no re-push).
// The synced row carries only {chapter, page}; the fine-grained `progress`
// fraction (used by the library's progress bar) lives locally. Preserve it when
// the incoming position is the same spot we already stored — this includes the
// realtime echo of our OWN last push, which would otherwise wipe `progress` and
// snap the bar back toward 0% right after closing the book. Only when the remote
// genuinely points elsewhere do we fall back to a coarse chapter estimate.
export async function applyRemoteProgress(id, location) {
  const book = await getBook(id);
  if (!book) return; // book not in this device's library
  const prev = book.lastLocation || {};
  const sameSpot =
    prev.chapter === location.chapter && prev.page === location.page;
  const progress =
    sameSpot && typeof prev.progress === "number"
      ? prev.progress
      : book.chapters?.length
        ? Math.min(1, (location.chapter || 0) / book.chapters.length)
        : 0;
  book.lastLocation = { ...location, progress };
  await putBook(book);
}

// Unique id = wall-clock time marker + randomness, so IDs never repeat even when
// the same book is imported twice.
export function makeId() {
  return "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

// ---- Dictionary (per-user word -> translation) -----------------------------
// The dictionary cache is keyed by the signed-in user so that different users
// on the same browser never see each other's words. `null` = local-only mode.

let activeUser = null;
let dict = loadDict();

function dictKey() {
  return activeUser ? `${DICT_KEY}:${activeUser}` : DICT_KEY;
}

function loadDict() {
  try {
    const raw = localStorage.getItem(dictKey());
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistDict() {
  try {
    localStorage.setItem(dictKey(), JSON.stringify(dict));
  } catch (e) {
    // Quota exceeded / private-mode write failure must not take down the caller
    // (setEntry is called straight from the save button).
    console.error("Dictionary save failed:", e);
  }
}

// Bumped on every dictionary mutation. Lets callers cache derived values (e.g.
// the library's per-book saved-word count) against a key that actually changes
// when the contents change — a size-based key misses a delete+add replacement.
let dictVersion = 0;
export function getDictVersion() {
  return dictVersion;
}

// Switch the active user; reloads that user's cached dictionary into memory.
// Call on sign-in (with the user id) and sign-out (with null).
export function setActiveUser(userId) {
  activeUser = userId || null;
  dict = loadDict();
  dictVersion++;
}

// Returns the live in-memory dictionary object. Keys are lowercased words.
export function getDict() {
  return dict;
}

// Optional push hook installed by the sync layer. Called after a LOCAL change
// so it can be propagated to Supabase. Remote-originated changes use the
// applyRemote* helpers below, which deliberately do NOT call this (no loops).
let pushFn = null;
export function setSyncPush(fn) {
  pushFn = fn;
}

export function setEntry(word, translation) {
  const w = word.toLowerCase();
  dict[w] = translation;
  dictVersion++;
  persistDict();
  if (pushFn) pushFn("set", w, translation);
}

export function deleteEntry(word) {
  const w = word.toLowerCase();
  delete dict[w];
  dictVersion++;
  persistDict();
  if (pushFn) pushFn("delete", w);
}

export function hasEntry(word) {
  return Object.prototype.hasOwnProperty.call(dict, word.toLowerCase());
}

// Apply a change that came FROM the server (no re-push).
export function applyRemoteSet(word, translation) {
  dict[word.toLowerCase()] = translation;
  dictVersion++;
  persistDict();
}

export function applyRemoteDelete(word) {
  delete dict[word.toLowerCase()];
  dictVersion++;
  persistDict();
}
