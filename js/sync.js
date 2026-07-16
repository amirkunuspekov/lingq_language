// sync.js — cross-device word-list sync via Supabase.
//
// Strategy: localStorage stays the instant, offline-capable source used by the
// reader/highlighter. Supabase is layered on top:
//   • On start: pull all remote rows into local, then push any local-only words
//     that were never synced (one-time migration + offline edits).
//   • On local change (setEntry/deleteEntry): push to Supabase.
//   • Realtime: remote changes from other devices flow back in live.
// Deletions are tombstones (deleted=true) so a delete on one device isn't
// resurrected by another device's pending local copy.

import {
  getDict,
  setSyncPush,
  applyRemoteSet,
  applyRemoteDelete,
  setProgressPush,
  applyRemoteProgress,
} from "./storage.js";
import { getClient, isConfigured } from "./supabaseClient.js";

const TABLE = "translations";
const PROGRESS_TABLE = "reading_progress";
let sb = null;
let onChange = () => {};
let onProgressChange = () => {};

export { isConfigured };

// Initialize per-user sync AFTER the user is signed in (RLS scopes every row to
// auth.uid()). Safe to call when unconfigured (no-op) and never throws.
export async function initSync(opts = {}) {
  onChange = opts.onDictChange || (() => {});
  onProgressChange = opts.onProgressChange || (() => {});
  if (!isConfigured()) {
    console.info("Supabase not configured — running local-only (no sync).");
    return;
  }
  try {
    sb = await getClient();
    if (!sb) return;
    setSyncPush(pushToRemote); // local dictionary changes -> Supabase
    setProgressPush(pushProgress); // local reading position -> Supabase
    await reconcile(); // initial dictionary two-way sync
    await reconcileProgress(); // initial reading-position pull
    subscribeRealtime(); // live updates from other devices
  } catch (e) {
    console.error("Sync init failed — continuing local-only:", e);
  }
}

// Pull remote -> local, then push local-only words up.
async function reconcile() {
  const { data, error } = await sb.from(TABLE).select("word, translation, deleted, status");
  if (error) {
    console.error("Sync pull failed:", error);
    return;
  }

  const remoteWords = new Set();
  for (const row of data) {
    remoteWords.add(row.word);
    if (row.deleted) applyRemoteDelete(row.word);
    else applyRemoteSet(row.word, { translation: row.translation, status: row.status });
  }

  // Push words that exist only locally and were never synced (won't resurrect
  // tombstones, since those words are already in remoteWords).
  const local = getDict();
  const newRows = Object.keys(local)
    .filter((w) => !remoteWords.has(w))
    .map((w) => ({
      word: w,
      translation: local[w].translation,
      status: local[w].status,
      deleted: false,
    }));
  if (newRows.length) {
    const { error: upErr } = await sb.from(TABLE).upsert(newRows);
    if (upErr) console.error("Sync initial push failed:", upErr);
  }

  onChange();
}

// Called by storage.js after a local set/delete.
async function pushToRemote(op, word, entry) {
  if (!sb) return;
  const row =
    op === "delete"
      ? { word, deleted: true, updated_at: new Date().toISOString() }
      : {
          word,
          translation: entry.translation,
          status: entry.status,
          deleted: false,
          updated_at: new Date().toISOString(),
        };
  const { error } = await sb.from(TABLE).upsert(row);
  if (error) console.error("Sync push failed for", word, error);
}

// ---- Reading position ------------------------------------------------------

// Pull all remote reading positions into the local library (books not present
// locally are skipped inside applyRemoteProgress).
async function reconcileProgress() {
  const { data, error } = await sb
    .from(PROGRESS_TABLE)
    .select("book_id, chapter, page");
  if (error) {
    console.error("Progress pull failed:", error);
    return;
  }
  for (const row of data) {
    await applyRemoteProgress(row.book_id, {
      chapter: row.chapter ?? 0,
      page: row.page ?? 0,
    });
  }
  onProgressChange();
}

// updateLocation fires on every page flip, so coalesce rapid flips into a
// single upsert per book (~1.5s after the last flip).
const progressTimers = new Map();
function pushProgress(bookId, location) {
  if (!sb) return;
  clearTimeout(progressTimers.get(bookId));
  progressTimers.set(
    bookId,
    setTimeout(async () => {
      progressTimers.delete(bookId);
      const { error } = await sb.from(PROGRESS_TABLE).upsert({
        book_id: bookId,
        chapter: location.chapter ?? 0,
        page: location.page ?? 0,
        updated_at: new Date().toISOString(),
      });
      if (error) console.error("Progress push failed for", bookId, error);
    }, 1500),
  );
}

function subscribeRealtime() {
  sb.channel("translations-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: TABLE },
      (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        if (!row || !row.word) return;
        if (payload.eventType === "DELETE" || row.deleted) {
          applyRemoteDelete(row.word);
        } else {
          applyRemoteSet(row.word, { translation: row.translation, status: row.status });
        }
        onChange();
      },
    )
    .subscribe();

  sb.channel("progress-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: PROGRESS_TABLE },
      async (payload) => {
        const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
        if (!row || !row.book_id) return;
        await applyRemoteProgress(row.book_id, {
          chapter: row.chapter ?? 0,
          page: row.page ?? 0,
        });
        onProgressChange();
      },
    )
    .subscribe();
}
