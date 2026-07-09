// dictionary.js — the Word List view: a searchable table of the global
// word/translation dictionary with inline editing, deletion, and CSV export.

import { getDict, setEntry, deleteEntry } from "./storage.js";

let els = null;
let onDictChange = () => {};

export function initWordList(refs, dictChangeCallback) {
  els = refs;
  onDictChange = dictChangeCallback;
  els.search.addEventListener("input", render);
  els.exportBtn.addEventListener("click", exportCsv);
}

export function render() {
  const dict = getDict();
  const query = (els.search.value || "").trim().toLowerCase();
  const words = Object.keys(dict)
    .filter((w) => !query || w.includes(query) || dict[w].toLowerCase().includes(query))
    .sort((a, b) => a.localeCompare(b));

  els.count.textContent = `${Object.keys(dict).length} word${
    Object.keys(dict).length === 1 ? "" : "s"
  }`;

  const tbody = els.tbody;
  tbody.innerHTML = "";

  if (words.length === 0) {
    els.empty.classList.remove("hidden");
    els.table.classList.add("hidden");
    return;
  }
  els.empty.classList.add("hidden");
  els.table.classList.remove("hidden");

  for (const word of words) {
    const tr = document.createElement("tr");

    const tdWord = document.createElement("td");
    tdWord.className = "wl-word";
    tdWord.textContent = word;

    const tdTrans = document.createElement("td");
    const input = document.createElement("input");
    input.className = "wl-trans-input";
    input.value = dict[word];
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (v) {
        setEntry(word, v);
      } else {
        input.value = dict[word]; // reject empty
      }
      onDictChange();
    });
    tdTrans.appendChild(input);

    const tdDel = document.createElement("td");
    tdDel.className = "wl-del-cell";
    const del = document.createElement("button");
    del.className = "wl-del";
    del.title = "Delete";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      deleteEntry(word);
      render();
      onDictChange();
    });
    tdDel.appendChild(del);

    tr.append(tdWord, tdTrans, tdDel);
    tbody.appendChild(tr);
  }
}

// ---- CSV export (RFC 4180) -------------------------------------------------

function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv() {
  const dict = getDict();
  const rows = [["word", "translation"]];
  Object.keys(dict)
    .sort((a, b) => a.localeCompare(b))
    .forEach((w) => rows.push([w, dict[w]]));

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
