// contextmenu.js — word interactions inside the reader:
//   • Desktop: right-click a word -> "Add translation"; right-click a highlight
//     -> "Show translation" / "Remove".
//   • Touch (no right-click): selecting a word shows a floating button, and
//     tapping an existing highlight opens the study card.
// Tapping a saved word opens a self-test card rather than just printing the
// meaning: the translation starts blurred, you recall it, reveal, then grade
// yourself. The meaning is never revealed by accident — no hover path exists.

import {
  setEntry,
  deleteEntry,
  hasEntry,
  getDict,
  setStatus,
} from "./storage.js";
import { lookupTranslation } from "./translate.js";

let els = null;
let onDictChange = () => {};
let pendingWord = ""; // word awaiting a translation in the modal
let lookupToken = 0; // guards against a stale auto-fill landing on a new word

// Stands in for the translation on the study card until it's revealed. Blurred
// by CSS into a soft smear, so it reads as "hidden text" — but it is the SAME
// for every word, which is the whole point: the real translation's length must
// not be visible before you've tried to recall it.
const MASK_TEXT = `Geradeaus`;

// Captured when the selection toolbar is shown, so a tap on the button still
// works even after the tap collapses the selection (common on mobile).
let selWord = "";
let selAnchor = { x: 0, y: 0 };
let selTimer = null;

export function initContextMenu(refs, dictChangeCallback) {
  els = refs;
  onDictChange = dictChangeCallback;

  els.reader.addEventListener("contextmenu", onContextMenu);

  // Tap/click an existing highlight -> menu (primary path for highlights on
  // touch, and a convenience on desktop).
  els.reader.addEventListener("click", onReaderClick);

  // Selection toolbar: appears whenever a word/phrase is selected.
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(updateSelToolbar, 120);
  });
  // Keep the selection when pressing the toolbar (desktop mousedown would
  // otherwise clear it before the click fires).
  els.selToolbar.addEventListener("mousedown", (e) => e.preventDefault());
  els.selToolbar.addEventListener("click", onSelToolbarClick);

  // Dismiss transient UI on outside interaction.
  document.addEventListener("mousedown", (e) => {
    if (!els.menu.contains(e.target)) hideMenu();
    if (els.popover && !els.popover.contains(e.target)) hidePopover();
  });
  document.addEventListener(
    "scroll",
    () => {
      hidePopover();
      hideSelToolbar();
    },
    true,
  );
  window.addEventListener("resize", () => {
    hideMenu();
    hidePopover();
    hideSelToolbar();
  });

  // Modal wiring.
  els.modalSave.addEventListener("click", saveTranslation);
  els.modalInput.addEventListener("keydown", (e) => {
    // Belt-and-braces with the reader's own guard: never let the modal's keys
    // reach the document-level reader shortcuts (Escape → exit, arrows → flip).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.stopPropagation();
      saveTranslation();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      closeModal();
    }
  });
  els.overlay.addEventListener("mousedown", closeModal);
}

// ---- Selection toolbar (touch-friendly Add/Show button) --------------------

function readerVisible() {
  return !els.reader.classList.contains("hidden");
}

function updateSelToolbar() {
  // Never compete with the modal.
  if (!els.modal.classList.contains("hidden")) return hideSelToolbar();
  if (!readerVisible()) return hideSelToolbar();

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideSelToolbar();
  const text = sel.toString().trim();
  if (!text || !isReasonableSelection(text)) return hideSelToolbar();
  // The selection must live inside the book text.
  if (!els.bookText.contains(sel.anchorNode)) return hideSelToolbar();

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return hideSelToolbar();

  selWord = text;
  selAnchor = { x: rect.left + rect.width / 2, y: rect.top };

  const btn = els.selToolbar;
  btn.textContent = hasEntry(text) ? "Show translation" : "Add translation";
  btn.classList.remove("hidden");

  const bw = btn.getBoundingClientRect();
  let left = selAnchor.x - bw.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw.width - 8));
  let top = rect.top - bw.height - 10;
  if (top < 8) top = rect.bottom + 10; // flip below if no room above
  btn.style.left = left + "px";
  btn.style.top = top + "px";
}

function hideSelToolbar() {
  els.selToolbar.classList.add("hidden");
}

function onSelToolbarClick() {
  const word = selWord;
  hideSelToolbar();
  if (!word) return;
  if (hasEntry(word)) {
    showTextPopover(word, selAnchor.x, selAnchor.y);
  } else {
    openModal(word);
  }
}

// Tapping a saved word goes straight to the study card — the old two-item menu
// ("Show translation" / "Remove") was a step in front of the thing you wanted,
// and Remove now lives in the card itself.
function onReaderClick(e) {
  const highlight = e.target.closest(".custom-highlight");
  if (!highlight) return;
  // Only treat it as a tap when nothing is being selected (so drag-selecting
  // that ends on a highlight doesn't trigger the card).
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  hideMenu();
  showTranslationPopover(highlight);
}

function onContextMenu(e) {
  const highlight = e.target.closest(".custom-highlight");
  const selectionText = window.getSelection().toString().trim();

  // Case 1: right-click on an existing highlighted word.
  if (highlight) {
    e.preventDefault();
    const word = highlight.dataset.word;
    showMenu(e.clientX, e.clientY, [
      {
        label: "Show translation",
        action: () => showTranslationPopover(highlight),
      },
      {
        label: "Remove translation",
        danger: true,
        action: () => removeWord(word),
      },
    ]);
    return;
  }

  // Case 2: a selection exists and isn't already translated.
  if (selectionText && isReasonableSelection(selectionText)) {
    e.preventDefault();
    const items = [];
    if (hasEntry(selectionText)) {
      items.push({
        label: "Show translation",
        action: () => showTextPopover(selectionText, e.clientX, e.clientY),
      });
      items.push({
        label: "Remove translation",
        danger: true,
        action: () => removeWord(selectionText),
      });
    } else {
      items.push({
        label: `Add translation for “${truncate(selectionText)}”`,
        action: () => openModal(selectionText),
      });
    }
    showMenu(e.clientX, e.clientY, items);
    return;
  }
  // Otherwise: let the native menu appear.
}

function isReasonableSelection(text) {
  // A word or short phrase; reject giant multi-line selections.
  return text.length <= 80 && !text.includes("\n");
}

function truncate(t) {
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

// ---- Floating menu ---------------------------------------------------------

function showMenu(x, y, items) {
  const menu = els.menu;
  menu.innerHTML = "";
  items.forEach((it) => {
    const btn = document.createElement("button");
    btn.className = "ctx-item" + (it.danger ? " danger" : "");
    btn.textContent = it.label;
    btn.addEventListener("click", () => {
      hideMenu();
      it.action();
    });
    menu.appendChild(btn);
  });
  menu.classList.remove("hidden");
  // Keep it on-screen.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function hideMenu() {
  els.menu.classList.add("hidden");
}

// ---- Study card (on demand) ------------------------------------------------
// Tapping a saved word opens this rather than just printing the meaning: the
// translation starts blurred so you get a beat to recall it, Reveal shows it,
// then you grade yourself — Fail marks the word "learning", Success "known".

function showTranslationPopover(highlightEl) {
  const translation =
    getDict()[highlightEl.dataset.word]?.translation || "(no translation)";
  const rect = highlightEl.getBoundingClientRect();
  showCard(
    highlightEl.dataset.word,
    translation,
    rect.left + rect.width / 2,
    rect.top,
  );
}

function showTextPopover(word, x, y) {
  const translation =
    getDict()[word.toLowerCase()]?.translation || "(no translation)";
  showCard(word, translation, x, y);
}

function showCard(word, translation, centerX, topY) {
  const pop = els.popover;
  pop.innerHTML = "";

  // Head: the word, plus a Remove — tapping a highlight no longer opens the
  // menu that used to carry it, and touch has no right-click fallback.
  const head = document.createElement("div");
  head.className = "pop-head";
  const headword = document.createElement("span");
  headword.className = "pop-word";
  headword.textContent = word;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pop-remove";
  remove.textContent = "Remove";
  remove.title = `Remove “${word}” from your word list`;
  remove.addEventListener("click", () => {
    hidePopover();
    removeWord(word);
  });
  head.append(headword, remove);

  // The hidden translation. The real text is never rendered before the reveal —
  // a blurred version of it would leak its length, and its line count would leak
  // through the card's height even at opacity 0. So a fixed-size mask stands in
  // for it, and the translation is held out of flow until it's revealed.
  const slot = document.createElement("div");
  slot.className = "pop-slot";

  const mask = document.createElement("div");
  mask.className = "pop-mask";
  mask.textContent = MASK_TEXT;
  mask.setAttribute("aria-hidden", "true");

  const trans = document.createElement("div");
  trans.className = "pop-trans";
  trans.textContent = translation;

  slot.append(mask, trans);

  const actions = document.createElement("div");
  actions.className = "pop-actions";

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "pop-btn pop-primary";
  reveal.textContent = "Reveal translation";

  const fail = document.createElement("button");
  fail.type = "button";
  fail.className = "pop-btn pop-secondary";
  fail.textContent = "Fail";
  fail.addEventListener("click", () => grade(word, "learning"));

  const success = document.createElement("button");
  success.type = "button";
  success.className = "pop-btn pop-primary";
  success.textContent = "Success";
  success.addEventListener("click", () => grade(word, "known"));

  // Revealing crossfades the mask out and the translation in, and swaps the
  // single button for the two grading ones. The mask is a reveal target too —
  // that's where the eye already is.
  const doReveal = () => {
    slot.classList.add("revealed");
    actions.replaceChildren(fail, success);
  };
  reveal.addEventListener("click", doReveal);
  slot.addEventListener("click", () => {
    if (!slot.classList.contains("revealed")) doReveal();
  });

  actions.appendChild(reveal);
  pop.append(head, slot, actions);
  pop.classList.remove("hidden");
  positionPopover(centerX, topY);
}

// Record how the self-test went. setStatus ignores unknown words, so the
// "(no translation)" edge case can't write a bogus entry.
function grade(word, status) {
  setStatus(word, status);
  hidePopover();
  window.getSelection()?.removeAllRanges();
  onDictChange();
}

// Anchor the card above the word, flipping below and clamping to the viewport
// when there's no room. Must run after the card is populated and visible.
function positionPopover(centerX, topY) {
  const pop = els.popover;
  const rect = pop.getBoundingClientRect();
  let left = centerX - rect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
  let top = topY - rect.height - 10;
  if (top < 8) top = topY + 24; // flip below if no room above
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}

function hidePopover() {
  if (els.popover) els.popover.classList.add("hidden");
}

// ---- Add-translation modal -------------------------------------------------

function openModal(word) {
  pendingWord = word;
  hideSelToolbar();
  hideMenu();
  els.modalWord.textContent = word;
  const existing = getDict()[word.toLowerCase()]?.translation || "";
  els.modalInput.value = existing;
  els.modal.classList.remove("hidden");
  els.overlay.classList.remove("hidden");
  els.modalInput.focus();

  // For a brand-new word, fetch a suggested translation and drop it into the
  // (fully editable) field. Skip it when the word is already translated.
  if (!existing) autoFillTranslation(word);
}

// Look up `word` and pre-fill the modal's translation field. The field stays
// editable the whole time: if the lookup fails, or the user has already started
// typing, or the modal has moved on to a different word, we leave it alone.
async function autoFillTranslation(word) {
  const token = ++lookupToken;
  const input = els.modalInput;
  input.classList.add("looking-up");
  input.placeholder = "Looking up…";

  const translation = await lookupTranslation(word);

  input.classList.remove("looking-up");
  input.placeholder = "Type the translation…";
  if (token !== lookupToken) return; // a newer lookup superseded this one
  if (pendingWord !== word) return; // modal closed or opened another word
  if (input.value.trim()) return; // user already typed something
  if (translation) input.value = translation;
}

function closeModal() {
  els.modal.classList.add("hidden");
  els.overlay.classList.add("hidden");
  pendingWord = "";
}

function saveTranslation() {
  const value = els.modalInput.value.trim();
  if (pendingWord && value) {
    setEntry(pendingWord, value);
    onDictChange();
  }
  closeModal();
  window.getSelection().removeAllRanges();
}

function removeWord(word) {
  deleteEntry(word);
  onDictChange();
}
