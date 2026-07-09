// contextmenu.js — right-click interactions inside the reader:
//   • right-click a plain selected word -> "Add translation" (opens modal)
//   • right-click an existing highlight  -> "Show translation" / "Remove"
// "Show translation" is deliberately an explicit action (a menu click), never
// a hover, so the reader never reveals the meaning by accident.

import { setEntry, deleteEntry, hasEntry, getDict } from "./storage.js";

let els = null;
let onDictChange = () => {};
let pendingWord = ""; // word awaiting a translation in the modal

export function initContextMenu(refs, dictChangeCallback) {
  els = refs;
  onDictChange = dictChangeCallback;

  els.reader.addEventListener("contextmenu", onContextMenu);

  // Dismiss the menu on any outside interaction.
  document.addEventListener("mousedown", (e) => {
    if (!els.menu.contains(e.target)) hideMenu();
    if (els.popover && !els.popover.contains(e.target)) hidePopover();
  });
  document.addEventListener("scroll", hidePopover, true);
  window.addEventListener("resize", () => {
    hideMenu();
    hidePopover();
  });

  // Modal wiring.
  els.modalSave.addEventListener("click", saveTranslation);
  els.modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveTranslation();
    if (e.key === "Escape") closeModal();
  });
  els.overlay.addEventListener("mousedown", closeModal);
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
  els.modalWord.textContent = word;
  els.modalInput.value = getDict()[word.toLowerCase()] || "";
  els.modal.classList.remove("hidden");
  els.overlay.classList.remove("hidden");
  els.modalInput.focus();
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
