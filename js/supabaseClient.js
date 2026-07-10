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
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2")
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
