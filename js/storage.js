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
export async function applyRemoteProgress(id, location) {
  const book = await getBook(id);
  if (!book) return; // book not in this device's library
  book.lastLocation = location;
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
  localStorage.setItem(dictKey(), JSON.stringify(dict));
}

// Switch the active user; reloads that user's cached dictionary into memory.
// Call on sign-in (with the user id) and sign-out (with null).
export function setActiveUser(userId) {
  activeUser = userId || null;
  dict = loadDict();
}

export function getActiveUser() {
  return activeUser;
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
  persistDict();
  if (pushFn) pushFn("set", w, translation);
}

export function deleteEntry(word) {
  const w = word.toLowerCase();
  delete dict[w];
  persistDict();
  if (pushFn) pushFn("delete", w);
}

export function hasEntry(word) {
  return Object.prototype.hasOwnProperty.call(dict, word.toLowerCase());
}

// Apply a change that came FROM the server (no re-push).
export function applyRemoteSet(word, translation) {
  dict[word.toLowerCase()] = translation;
  persistDict();
}

export function applyRemoteDelete(word) {
  delete dict[word.toLowerCase()];
  persistDict();
}
