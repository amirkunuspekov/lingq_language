// reader.js — the reading view. One chapter is rendered at a time as a single
// normal-flow column and read by vertical scrolling; left/right (swipe or the
// arrow controls) move between chapters. Vertical scrolling is used instead of
// CSS multi-column pagination because iOS Safari cannot select text in the
// continuation fragment of a paragraph split across columns — with a single
// scrolling column every word is selectable.

import { getBook, getDict, updateLocation } from "./storage.js";

let els = null; // cached DOM references, filled on init
let book = null; // active book object
let chapterIndex = 0;

let onExit = () => {}; // callback to return to library

export function initReader(refs, exitCallback) {
  els = refs;
  onExit = exitCallback;

  // The arrow controls now move between chapters (there are no in-chapter pages).
  els.flipForward.addEventListener("click", () => changeChapter(+1));
  els.flipBackward.addEventListener("click", () => changeChapter(-1));
  els.back.addEventListener("click", () => onExit());

  document.addEventListener("keydown", (e) => {
    if (els.view.classList.contains("hidden")) return;
    // Left/Right change chapters; Up/Down/space fall through to native scroll.
    if (e.key === "ArrowRight") changeChapter(+1);
    else if (e.key === "ArrowLeft") changeChapter(-1);
    else if (e.key === "Escape") onExit();
  });

  // Track scroll: update the progress bar live and persist the position (throttled).
  let scrollRaf = null;
  let persistTimer = null;
  els.viewport.addEventListener(
    "scroll",
    () => {
      if (!book || els.view.classList.contains("hidden")) return;
      if (!scrollRaf) {
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = null;
          updateProgress();
        });
      }
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistLocation, 400);
    },
    { passive: true },
  );

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (els.view.classList.contains("hidden")) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderChapter(currentFraction()), 150);
  });

  initSwipe();
  initChrome();
}

// Apple Books–style auto-hiding chrome (mobile): a generic tap on the page
// toggles the header; it also auto-hides after 5s of inactivity. On desktop the
// header is always shown via CSS, so toggling the class is a harmless no-op.
let chromeTimer = null;

function showChrome() {
  els.view.classList.add("chrome-visible");
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(hideChrome, 5000);
}

function hideChrome() {
  els.view.classList.remove("chrome-visible");
  clearTimeout(chromeTimer);
}

function toggleChrome() {
  if (els.view.classList.contains("chrome-visible")) hideChrome();
  else showChrome();
}

function initChrome() {
  // Generic tap on the reading area toggles the header.
  els.viewport.addEventListener("click", (e) => {
    if (e.target.closest(".custom-highlight")) return; // highlight menu handles it
    if (e.target.closest(".page-button")) return; // chapter arrows
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // mid text-selection
    toggleChrome();
  });
  // Interacting with the header keeps it alive (resets the 5s timer).
  els.view.querySelector(".reader-bar")?.addEventListener("click", () => {
    if (els.view.classList.contains("chrome-visible")) showChrome();
  });
}

// Horizontal swipe changes chapters (vertical drags scroll natively and are
// ignored here). This is the primary chapter gesture on touch devices.
function initSwipe() {
  let startX = 0, startY = 0, active = false;
  els.viewport.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) { active = false; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      active = true;
    },
    { passive: true },
  );
  els.viewport.addEventListener(
    "touchend",
    (e) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // Require a clearly horizontal swipe; ignore taps and vertical scrolls.
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      // Don't change chapters while the user is selecting text.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      changeChapter(dx < 0 ? +1 : -1);
    },
    { passive: true },
  );
}

export function isOpen() {
  return book !== null && !els.view.classList.contains("hidden");
}

// ---- Open / render ---------------------------------------------------------

export async function openBook(id) {
  book = await getBook(id);
  if (!book) return;
  chapterIndex = book.lastLocation?.chapter || 0;
  // Position within a chapter is stored as a scroll fraction in permille (0–1000)
  // so it maps across devices/orientations regardless of layout height.
  const startFraction = (book.lastLocation?.page || 0) / 1000;
  els.title.textContent = book.title;
  buildContentsMenu();
  // The view must already be visible so the viewport has real dimensions to
  // measure — the caller (main.js) reveals the reader before calling openBook.
  els.view.classList.remove("hidden");
  hideChrome(); // start with chrome hidden (Apple Books style, mobile)
  renderChapter(startFraction);
}

function currentChapterHtml() {
  const ch = book.chapters[chapterIndex];
  if (!ch) return "";
  if (ch.html) return ch.html;
  // Legacy chapters stored as plain text: escape and wrap in a paragraph.
  const esc = (ch.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return "<p>" + esc.replace(/\n\s*\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
}

// (Re)render the current chapter and scroll to `fraction` (0–1 of the scrollable
// height). Re-applies highlights so removed translations disappear and current
// ones show.
function renderChapter(fraction = 0) {
  els.bookText.innerHTML = currentChapterHtml();
  applyHighlights();
  updateChapterLabel();

  // Restore the scroll position after layout. iOS occasionally needs a second
  // tick once layout has settled, so re-apply on the next frame.
  const apply = () => {
    const scrollable = els.viewport.scrollHeight - els.viewport.clientHeight;
    els.viewport.scrollTop = Math.max(0, fraction * scrollable);
    updateProgress();
  };
  apply();
  requestAnimationFrame(apply);
  persistLocation();
}

// Re-apply highlights after the dictionary changes (add/remove a word).
export function refreshHighlights() {
  if (!isOpen()) return;
  renderChapter(currentFraction());
}

// Current vertical scroll position as a 0–1 fraction of the scrollable height.
function currentFraction() {
  const scrollable = els.viewport.scrollHeight - els.viewport.clientHeight;
  return scrollable > 0 ? els.viewport.scrollTop / scrollable : 0;
}

// ---- Chapter navigation ----------------------------------------------------

function changeChapter(dir) {
  const target = chapterIndex + dir;
  if (target < 0 || target >= book.chapters.length) return;
  chapterIndex = target;
  renderChapter(0);
}

function updateProgress() {
  const chapters = book.chapters.length;
  const bookFrac = (chapterIndex + currentFraction()) / chapters;
  els.progressFill.style.width = `${Math.min(100, bookFrac * 100)}%`;
  if (els.pageCount) els.pageCount.textContent = `${Math.round(bookFrac * 100)}%`;
}

function updateChapterLabel() {
  if (els.chapterLabel) {
    els.chapterLabel.textContent =
      book.chapters[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`;
  }
}

function persistLocation() {
  if (!book) return;
  updateLocation(book.id, {
    chapter: chapterIndex,
    page: Math.round(currentFraction() * 1000),
  });
}

// ---- Table of contents -----------------------------------------------------

function buildContentsMenu() {
  const list = els.contentsList;
  list.innerHTML = "";
  book.chapters.forEach((ch, i) => {
    const li = document.createElement("button");
    li.className = "toc-item";
    li.textContent = ch.title || `Chapter ${i + 1}`;
    li.addEventListener("click", () => {
      chapterIndex = i;
      renderChapter(0);
      els.contentsPanel.classList.add("hidden");
    });
    list.appendChild(li);
  });
}

// ---- Highlighting ----------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap every dictionary word in the chapter. With a single scrolling column the
// whole chapter is laid out at once, so there's no per-page banding — one pass
// on render (and on dictionary change) is enough.
function applyHighlights() {
  const dict = getDict();
  const words = Object.keys(dict);
  if (words.length === 0) return;

  // Whole-word match using Unicode-aware boundaries (JS \b is ASCII-only and
  // would break inside words like "Wänden"). Letters must not sit on either side.
  const alt = words.map(escapeRegex).join("|");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])(${alt})(?![\\p{L}\\p{N}])`, "giu");
  const walker = document.createTreeWalker(els.bookText, NodeFilter.SHOW_TEXT);

  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.classList.contains("custom-highlight")) continue;
    if (!node.textContent.trim()) continue;

    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(node.textContent)) !== null) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push([range, match[1]]);
    }
  }

  // Wrap in reverse document order so surrounding one match doesn't invalidate
  // the offsets of earlier matches in the same text node.
  for (const [range, word] of ranges.reverse()) {
    const span = document.createElement("span");
    span.className = "custom-highlight";
    span.dataset.word = word.toLowerCase();
    span.dataset.translation = dict[word.toLowerCase()] || "";
    range.surroundContents(span);
  }
}
