// auth.js — email/password auth gate. Owns the login screen and the sign-out
// button; tells main.js when a user signs in (onAuth) or out (onSignOut). When
// Supabase isn't configured, there is no gate and the app runs local-only.

import { isConfigured, getClient } from "./supabaseClient.js";
import { purgeLocalUserData } from "./storage.js";

const $ = (id) => document.getElementById(id);

let cbs = { onAuth: () => {}, onSignOut: () => {} };
let els = null;
let sb = null;
let currentUserId = null; // whose local cache to purge on sign-out

export async function initAuth(callbacks) {
  cbs = callbacks;
  els = {
    gate: $("auth-gate"),
    app: $("app"),
    form: $("auth-form"),
    email: $("auth-email"),
    pass: $("auth-password"),
    err: $("auth-error"),
    signup: $("auth-signup"),
    signout: $("sign-out"),
    whoami: $("whoami"),
    accountBtn: $("account-btn"),
    accountMenu: $("account-menu"),
  };

  // Mobile avatar button toggles the account dropdown; any outside click (or
  // signing out) closes it. On desktop the menu is inline and the button is
  // hidden by CSS, so this wiring is inert there.
  els.accountBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.accountMenu.classList.toggle("open");
  });
  document.addEventListener("click", () => els.accountMenu.classList.remove("open"));

  // Local-only mode: no auth, no gate.
  if (!isConfigured()) {
    hideGate();
    els.signout.classList.add("hidden");
    cbs.onAuth(null);
    return;
  }

  sb = await getClient();
  if (!sb) {
    // Client failed to load; degrade to local-only rather than lock the user out.
    hideGate();
    els.signout.classList.add("hidden");
    cbs.onAuth(null);
    return;
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    signIn();
  });
  els.signup.addEventListener("click", signUp);
  els.signout.addEventListener("click", signOut);

  const { data } = await sb.auth.getSession();
  if (data.session) enterApp(data.session.user);
  else showGate();
}

function enterApp(user) {
  hideGate();
  currentUserId = user.id;
  els.whoami.textContent = user.email || "";
  els.signout.classList.remove("hidden");
  // Avatar initial for the mobile account button.
  els.accountBtn.textContent = (user.email || "?").charAt(0).toUpperCase();
  els.accountBtn.classList.remove("hidden");
  cbs.onAuth(user);
}

async function signIn() {
  clearError();
  const { data, error } = await sb.auth.signInWithPassword({
    email: els.email.value.trim(),
    password: els.pass.value,
  });
  if (error) return showError(error.message);
  enterApp(data.user);
}

async function signUp() {
  clearError();
  const email = els.email.value.trim();
  const password = els.pass.value;
  if (!email || password.length < 6)
    return showError("Enter an email and a password of at least 6 characters.");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return showError(error.message);
  if (data.session) {
    enterApp(data.user); // email confirmation disabled -> immediate session
  } else {
    // This is a success, not a failure — don't render it in the error style.
    showNotice("Account created. Check your email to confirm, then sign in.");
  }
}

async function signOut() {
  const uid = currentUserId;
  try {
    await sb.auth.signOut();
  } catch (e) {
    console.error("Sign-out failed:", e);
  }
  // Reloading only tears down memory, not disk — wipe this user's cached books
  // and word list so the next person on this device can't read them. Everything
  // re-pulls from the cloud on the next sign-in.
  try {
    await purgeLocalUserData(uid);
  } catch (e) {
    console.error("Local purge failed:", e);
  }
  currentUserId = null;
  cbs.onSignOut(); // full reload — the reliable teardown; the gate shows again
}

function showGate() {
  els.gate.classList.remove("hidden");
  els.app.classList.add("hidden");
}
function hideGate() {
  els.gate.classList.add("hidden");
  els.app.classList.remove("hidden");
}
function showError(msg) {
  els.err.textContent = msg;
  els.err.classList.remove("hidden", "notice");
}
// Same slot, neutral styling — for messages that aren't failures.
function showNotice(msg) {
  els.err.textContent = msg;
  els.err.classList.remove("hidden");
  els.err.classList.add("notice");
}
function clearError() {
  els.err.classList.add("hidden");
  els.err.classList.remove("notice");
}
