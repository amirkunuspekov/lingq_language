// booksync.js — per-user book sync. Each imported book is stored as one row in
// the `books` table (title/author/cover/chapters as JSON); RLS scopes rows to
// the signed-in user. Books are cached in IndexedDB after the first pull, so
// later loads are instant and offline-capable.

import { getClient } from "./supabaseClient.js";
import { getBook, putBook, deleteBook as deleteLocalBook } from "./storage.js";

const TABLE = "books";
const COLUMNS = "id, title, author, format, cover, chapters";

// Convert a DB row into a local book record owned by the current user.
function rowToBook(row, ownerId) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format,
    cover: row.cover,
    chapters: row.chapters || [],
    owner: ownerId,
    source: "cloud",
    addedAt: Date.now(),
    lastOpenedAt: 0,
    lastLocation: { chapter: 0, page: 0 },
  };
}

// Push a newly imported book up to the user's cloud library.
export async function uploadBook(book) {
  const sb = await getClient();
  if (!sb) return;
  const { error } = await sb.from(TABLE).insert({
    id: book.id, // a UUID assigned at import time when signed in
    title: book.title,
    author: book.author,
    format: book.format,
    cover: book.cover,
    chapters: book.chapters,
  });
  if (error) console.error("Book upload failed:", error);
}

// Pull the user's cloud books into IndexedDB (skips any already cached).
export async function pullBooks(ownerId, onChange) {
  const sb = await getClient();
  if (!sb) return;
  const { data, error } = await sb.from(TABLE).select(COLUMNS);
  if (error) {
    console.error("Book pull failed:", error);
    return;
  }
  let added = 0;
  for (const row of data) {
    if (await getBook(row.id)) continue; // already cached
    await putBook(rowToBook(row, ownerId));
    added++;
  }
  if (added > 0) onChange();
}

// Remove a book from the cloud (its local copy is deleted by the caller).
export async function deleteBookRemote(id) {
  const sb = await getClient();
  if (!sb) return;
  const { error } = await sb.from(TABLE).delete().eq("id", id);
  if (error) console.error("Book delete failed:", error);
}

// Live updates from the user's other devices.
export async function initBooksRealtime(ownerId, onChange) {
  const sb = await getClient();
  if (!sb) return;
  sb.channel("books-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLE },
      async (payload) => {
        if (payload.eventType === "DELETE") {
          const id = payload.old?.id;
          if (id) await deleteLocalBook(id);
        } else {
          const row = payload.new;
          if (row?.id && !(await getBook(row.id))) {
            await putBook(rowToBook(row, ownerId));
          }
        }
        onChange();
      },
    )
    .subscribe();
}
