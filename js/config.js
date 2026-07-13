// config.js — Supabase connection for cross-device word-list sync.
//
// Fill these in from your Supabase project:
//   Dashboard → Project Settings → Data API (or API):
//     • Project URL  -> SUPABASE_URL
//     • anon public key -> SUPABASE_ANON_KEY
//
// The anon key is DESIGNED to be public (it ships in the browser), so it's safe
// to commit. Access is controlled by the table's Row Level Security policy —
// see the SQL in the setup instructions. Leave the placeholders as-is to run
// the app in local-only mode (no sync).

export const SUPABASE_URL = "https://dqofeljpcrywqwxopmwv.supabase.co";
export const SUPABASE_ANON_KEY =
  "sb_publishable_wAfZbRS9hL3XrZOA_PBoFA_en8ZEINv";

// Automatic translation (MyMemory, free & keyless). This is the language pair
// used to pre-fill the translation field when you add a word while reading:
//   "<book language>|<your language>", e.g. "de|en" (German → English),
//   "de|ru" (German → Russian), "en|es", etc. Change just this one line to
//   switch languages. See https://mymemory.translated.net for supported codes.
export const LOOKUP_LANGPAIR = "de|en";
