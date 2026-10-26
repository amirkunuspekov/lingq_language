// translate.js — free, keyless machine translation via MyMemory, used to
// pre-fill the translation field when you add a word while reading.
//
// MyMemory needs no API key, so it's called straight from the browser (no
// server/proxy). Results are cached in memory for the session, so repeat
// lookups are instant and don't spend the daily free quota. Every failure
// (offline, quota exhausted, bad response) resolves to null so the caller can
// simply fall back to manual typing.

import { LOOKUP_LANGPAIR } from "./config.js";

const ENDPOINT = "https://api.mymemory.translated.net/get";
const cache = new Map(); // lowercased text -> translation string

export async function lookupTranslation(text) {
  const q = (text || "").trim();
  if (!q) return null;
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const url =
    `${ENDPOINT}?q=${encodeURIComponent(q)}` +
    `&langpair=${encodeURIComponent(LOOKUP_LANGPAIR)}`;
  // Without a timeout a hung request leaves the field stuck on "Looking up…"
  // forever; abort and fall back to manual entry instead.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    // A successful translation comes back with responseStatus 200; quota/errors
    // return a non-200 status and put a warning string in translatedText.
    if (String(data.responseStatus) !== "200") return null;
    const translation = (data.responseData?.translatedText || "").trim();
    if (!translation) return null;
    cache.set(key, translation);
    return translation;
  } catch {
    return null; // network/offline/timeout — caller falls back to manual entry
  } finally {
    clearTimeout(timer);
  }
}
