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

export async function updateLocation(id, location) {
  const book = await getBook(id);
  if (!book) return;
  book.lastLocation = location;
  book.lastOpenedAt = Date.now();
  await putBook(book);
}

// Simple unique id without relying on Date.now-only collisions.
export function makeId() {
  return "b_" + Math.random().toString(36).slice(2, 10) + "_" + performance.now().toFixed(0);
}

// ---- Dictionary (global word -> translation) -------------------------------

let dict = loadDict();

function loadDict() {
  try {
    const raw = localStorage.getItem(DICT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistDict() {
  localStorage.setItem(DICT_KEY, JSON.stringify(dict));
}

// Returns the live in-memory dictionary object. Keys are lowercased words.
export function getDict() {
  return dict;
}

export function setEntry(word, translation) {
  dict[word.toLowerCase()] = translation;
  persistDict();
}

export function deleteEntry(word) {
  delete dict[word.toLowerCase()];
  persistDict();
}

export function hasEntry(word) {
  return Object.prototype.hasOwnProperty.call(dict, word.toLowerCase());
}
