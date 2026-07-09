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
} from "./storage.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const TABLE = "translations";
let sb = null;
let onChange = () => {};

export function isConfigured() {
  return (
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("YOUR_") &&
    !SUPABASE_ANON_KEY.includes("YOUR_")
  );
}

// Initialize sync. Safe to call always: does nothing (local-only) if not
// configured, and never throws — a failed CDN/network just leaves the app
// working offline.
export async function initSync(changeCallback) {
  onChange = changeCallback || (() => {});
  if (!isConfigured()) {
    console.info("Supabase not configured — running local-only (no sync).");
    return;
  }
  try {
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2"
    );
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    setSyncPush(pushToRemote); // local changes -> Supabase
    await reconcile(); // initial two-way sync
    subscribeRealtime(); // live updates from other devices
  } catch (e) {
    console.error("Sync init failed — continuing local-only:", e);
  }
}

// Pull remote -> local, then push local-only words up.
async function reconcile() {
  const { data, error } = await sb.from(TABLE).select("word, translation, deleted");
  if (error) {
    console.error("Sync pull failed:", error);
    return;
  }

  const remoteWords = new Set();
  for (const row of data) {
    remoteWords.add(row.word);
    if (row.deleted) applyRemoteDelete(row.word);
    else applyRemoteSet(row.word, row.translation);
  }

  // Push words that exist only locally and were never synced (won't resurrect
  // tombstones, since those words are already in remoteWords).
  const local = getDict();
  const newRows = Object.keys(local)
    .filter((w) => !remoteWords.has(w))
    .map((w) => ({ word: w, translation: local[w], deleted: false }));
  if (newRows.length) {
    const { error: upErr } = await sb.from(TABLE).upsert(newRows);
    if (upErr) console.error("Sync initial push failed:", upErr);
  }

  onChange();
}

// Called by storage.js after a local set/delete.
async function pushToRemote(op, word, translation) {
  if (!sb) return;
  const row =
    op === "delete"
      ? { word, deleted: true, updated_at: new Date().toISOString() }
      : { word, translation, deleted: false, updated_at: new Date().toISOString() };
  const { error } = await sb.from(TABLE).upsert(row);
  if (error) console.error("Sync push failed for", word, error);
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
          applyRemoteSet(row.word, row.translation);
        }
        onChange();
      },
    )
    .subscribe();
}
