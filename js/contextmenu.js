// contextmenu.js — word interactions inside the reader:
//   • Desktop: right-click a word -> "Add translation"; right-click a highlight
//     -> "Show translation" / "Remove".
//   • Touch (no right-click): selecting a word shows a floating button, and
//     tapping an existing highlight opens the same menu.
// "Show translation" is deliberately an explicit action, never a hover, so the
// reader never reveals the meaning by accident.

import { setEntry, deleteEntry, hasEntry, getDict } from "./storage.js";
import { lookupTranslation } from "./translate.js";

let els = null;
let onDictChange = () => {};
let pendingWord = ""; // word awaiting a translation in the modal
let lookupToken = 0; // guards against a stale auto-fill landing on a new word

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
  document.addEventListener("scroll", () => {
    hidePopover();
    hideSelToolbar();
  }, true);
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

function onReaderClick(e) {
  const highlight = e.target.closest(".custom-highlight");
  if (!highlight) return;
  // Only treat it as a tap when nothing is being selected (so drag-selecting
  // that ends on a highlight doesn't trigger the menu).
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const rect = highlight.getBoundingClientRect();
  const word = highlight.dataset.word;
  showMenu(rect.left + rect.width / 2, rect.bottom + 4, [
    { label: "Show translation", action: () => showTranslationPopover(highlight) },
    { label: "Remove translation", danger: true, action: () => removeWord(word) },
  ]);
}

function onContextMenu(e) {
  const highlight = e.target.closest(".custom-highlight");
  const selectionText = window.getSelection().toString().trim();

  // Case 1: right-click on an existing highlighted word.
  if (highlight) {
    e.preventDefault();
    const word = highlight.dataset.word;
    showMenu(e.clientX, e.clientY, [
      { label: "Show translation", action: () => showTranslationPopover(highlight) },
      { label: "Remove translation", danger: true, action: () => removeWord(word) },
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

// ---- Translation popover (on demand) ---------------------------------------

function showTranslationPopover(highlightEl) {
  const translation = getDict()[highlightEl.dataset.word] || "(no translation)";
  const rect = highlightEl.getBoundingClientRect();
  positionPopover(highlightEl.dataset.word, translation, rect.left + rect.width / 2, rect.top);
}

function showTextPopover(word, x, y) {
  const translation = getDict()[word.toLowerCase()] || "(no translation)";
  positionPopover(word, translation, x, y);
}

function positionPopover(word, translation, centerX, topY) {
  const pop = els.popover;
  pop.innerHTML = `<span class="pop-word">${escapeHtml(word)}</span><span class="pop-trans">${escapeHtml(
    translation,
  )}</span>`;
  pop.classList.remove("hidden");
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
  const existing = getDict()[word.toLowerCase()] || "";
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

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
