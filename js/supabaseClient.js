// supabaseClient.js — one shared Supabase client for the whole app, so auth,
// dictionary sync, and book sync all use the same session. The client library
// is loaded from a CDN on demand; if it fails or isn't configured, callers get
// null and the app runs in local-only mode.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export function isConfigured() {
  return (
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    !SUPABASE_URL.includes("YOUR_") &&
    !SUPABASE_ANON_KEY.includes("YOUR_")
  );
}

let clientPromise = null;

// Returns the shared client (a Promise), or null if not configured. Never
// throws — a CDN/network failure resolves to null and the app stays local-only.
export function getClient() {
  if (!isConfigured()) return Promise.resolve(null);
  if (!clientPromise) {
    // Pinned to an exact version, not a floating "@2": a dynamic import can't
    // carry Subresource Integrity, so the version string is the only control we
    // have over what code esm.sh hands us. (This is the version "@2" already
    // resolved to — pinning changes nothing today, it just stops it drifting.)
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2.110.6")
      .then(({ createClient }) =>
        createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true },
        }),
      )
      .catch((e) => {
        console.error("Supabase client failed to load:", e);
        return null;
      });
  }
  return clientPromise;
}
