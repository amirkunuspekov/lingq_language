// dictionary.js — the Word List view: a searchable card list of the global
// word/translation dictionary with inline editing, deletion, and CSV export.

import {
  getDict,
  setEntry,
  deleteEntry,
  setStatus,
  STATUSES,
  STATUS_LABELS,
  DEFAULT_STATUS,
} from "./storage.js";

let els = null;
let onDictChange = () => {};
let activeFilter = "all"; // all | new | learning | known
let pendingStatus = DEFAULT_STATUS; // status picked in the add-word sheet

export function initWordList(refs, dictChangeCallback) {
  els = refs;
  onDictChange = dictChangeCallback;
  els.search.addEventListener("input", render);
  els.exportBtn.addEventListener("click", exportCsv);

  // Status filter tabs.
  els.filters.addEventListener("click", (e) => {
    const btn = e.target.closest(".wl-filter");
    if (btn) setFilter(btn.dataset.filter);
  });

  // Add-word sheet.
  els.addOpen.addEventListener("click", openSheet);
  els.addCancel.addEventListener("click", closeSheet);
  els.addForm.addEventListener("submit", handleAdd);
  els.addStatus.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-item");
    if (btn) setPendingStatus(btn.dataset.status);
  });
  els.overlay.addEventListener("mousedown", () => {
    if (!els.addSheet.classList.contains("hidden")) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.addSheet.classList.contains("hidden")) {
      e.stopPropagation(); // don't also exit the reader
      closeSheet();
    }
  });
}

function setFilter(filter) {
  activeFilter = filter;
  for (const b of els.filters.querySelectorAll(".wl-filter")) {
    b.classList.toggle("active", b.dataset.filter === filter);
  }
  render();
}

// ---- Add-word sheet --------------------------------------------------------

function openSheet() {
  els.addWord.value = "";
  els.addTrans.value = "";
  setPendingStatus(DEFAULT_STATUS);
  els.addSheet.classList.remove("hidden");
  els.overlay.classList.remove("hidden");
  els.addWord.focus();
}

function closeSheet() {
  els.addSheet.classList.add("hidden");
  els.overlay.classList.add("hidden");
}

function setPendingStatus(status) {
  pendingStatus = STATUSES.includes(status) ? status : DEFAULT_STATUS;
  for (const b of els.addStatus.querySelectorAll(".seg-item")) {
    b.classList.toggle("active", b.dataset.status === pendingStatus);
  }
}

function handleAdd(e) {
  e.preventDefault();
  const word = els.addWord.value.trim();
  const translation = els.addTrans.value.trim();
  if (!word || !translation) return;

  setEntry(word, translation, pendingStatus); // lowercases the key; overwrites if it exists
  closeSheet();

  // Clear any search/filter so the word that was just added is actually visible.
  els.search.value = "";
  setFilter("all");
  onDictChange();
}

export function render() {
  const dict = getDict();
  const query = (els.search.value || "").trim().toLowerCase();
  const all = Object.keys(dict);

  const words = all
    .filter((w) => activeFilter === "all" || dict[w].status === activeFilter)
    .filter(
      (w) => !query || w.includes(query) || dict[w].translation.toLowerCase().includes(query),
    )
    .sort((a, b) => a.localeCompare(b));

  const total = all.length;
  const newCount = all.filter((w) => dict[w].status === "new").length;
  els.count.textContent =
    `${total} word${total === 1 ? "" : "s"}` + (newCount ? ` · ${newCount} new` : "");

  const list = els.list;
  list.innerHTML = "";

  if (words.length === 0) {
    els.empty.classList.remove("hidden");
    list.classList.add("hidden");
    return;
  }
  els.empty.classList.add("hidden");
  list.classList.remove("hidden");

  for (const word of words) list.appendChild(wordRow(word, dict[word]));
}

// One row of the card list: a status dot, the word (serif) over its translation
// (editable in place), and a delete button.
function wordRow(word, entry) {
  const row = document.createElement("div");
  row.className = "wl-row";

  // The dot both shows the status and is the way to change it — cycles
  // new → learning → known.
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = `wl-dot status-${entry.status}`;
  dot.title = `${STATUS_LABELS[entry.status]} — click to change`;
  dot.setAttribute("aria-label", `Status of ${word}: ${STATUS_LABELS[entry.status]}`);
  dot.addEventListener("click", () => {
    setStatus(word, STATUSES[(STATUSES.indexOf(entry.status) + 1) % STATUSES.length]);
    render();
    onDictChange();
  });

  const main = document.createElement("div");
  main.className = "wl-row-main";

  const headword = document.createElement("div");
  headword.className = "wl-word";
  headword.textContent = word;

  const input = document.createElement("input");
  input.className = "wl-trans-input";
  input.value = entry.translation;
  input.setAttribute("aria-label", `Translation for ${word}`);
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (v) setEntry(word, v); // keeps the word's existing status
    else input.value = getDict()[word]?.translation ?? ""; // reject empty
    onDictChange();
  });

  main.append(headword, input);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "wl-del";
  del.title = `Delete “${word}”`;
  del.setAttribute("aria-label", `Delete ${word}`);
  del.textContent = "✕";
  del.addEventListener("click", () => {
    deleteEntry(word);
    render();
    onDictChange();
  });

  row.append(dot, main, del);
  return row;
}

// ---- CSV export (RFC 4180) -------------------------------------------------

function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv() {
  const dict = getDict();
  const rows = [["word", "translation", "status"]];
  Object.keys(dict)
    .sort((a, b) => a.localeCompare(b))
    .forEach((w) => rows.push([w, dict[w].translation, dict[w].status]));

  if (rows.length === 1) {
    alert("No words to export yet.");
    return;
  }

  const csv = rows.map((r) => r.map(csvField).join(",")).join("\r\n");
  // Prepend a UTF-8 BOM so Excel opens non-ASCII (umlauts/Cyrillic) correctly.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "translations.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
