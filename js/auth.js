// auth.js — email/password auth gate. Owns the login screen and the sign-out
// button; tells main.js when a user signs in (onAuth) or out (onSignOut). When
// Supabase isn't configured, there is no gate and the app runs local-only.

import { isConfigured, getClient } from "./supabaseClient.js";

const $ = (id) => document.getElementById(id);

let cbs = { onAuth: () => {}, onSignOut: () => {} };
let els = null;
let sb = null;

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
    showError("Account created. Check your email to confirm, then sign in.");
  }
}

async function signOut() {
  await sb.auth.signOut();
  // Full reload is the simplest reliable teardown (clears in-memory caches,
  // realtime channels, and the reader), then the gate shows again.
  location.reload();
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
  els.err.classList.remove("hidden");
}
function clearError() {
  els.err.classList.add("hidden");
}
