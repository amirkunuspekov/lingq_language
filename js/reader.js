// reader.js — the reading view: chapter rendering, column pagination with
// translateX windowing, and per-page word highlighting. The pagination and
// band-highlight logic is ported from the original prototype (archive/prototype)
// and generalized to render one chapter of the active book at a time.

import { getBook, getDict, updateLocation } from "./storage.js";

const GAP = 48; // px between page columns

let els = null; // cached DOM references, filled on init
let book = null; // active book object
let chapterIndex = 0;
let currentPage = 0;

// pageIndex -> Set of words already highlighted on that page.
let pageHighlightState = new Map();

let onExit = () => {}; // callback to return to library

export function initReader(refs, exitCallback) {
  els = refs;
  onExit = exitCallback;

  els.flipForward.addEventListener("click", () => flip(+1));
  els.flipBackward.addEventListener("click", () => flip(-1));
  els.back.addEventListener("click", () => onExit());

  document.addEventListener("keydown", (e) => {
    if (els.view.classList.contains("hidden")) return;
    if (e.key === "ArrowRight") flip(+1);
    else if (e.key === "ArrowLeft") flip(-1);
    else if (e.key === "Escape") onExit();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (els.view.classList.contains("hidden")) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderChapter(currentPage), 150);
  });
}

export function isOpen() {
  return book !== null && !els.view.classList.contains("hidden");
}

// ---- Open / render ---------------------------------------------------------

export async function openBook(id) {
  book = await getBook(id);
  if (!book) return;
  chapterIndex = book.lastLocation?.chapter || 0;
  const startPage = book.lastLocation?.page || 0;
  els.title.textContent = book.title;
  buildContentsMenu();
  // The view must already be visible so the viewport has real dimensions to
  // measure — the caller (main.js) reveals the reader before calling openBook.
  els.view.classList.remove("hidden");
  renderChapter(startPage);
}

function currentChapterHtml() {
  const ch = book.chapters[chapterIndex];
  if (!ch) return "";
  if (ch.html) return ch.html;
  // Legacy chapters stored as plain text: escape and wrap in a paragraph.
  const esc = (ch.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return "<p>" + esc.replace(/\n\s*\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
}

// (Re)render the current chapter and move to `page`. Resets highlight state so
// removed translations disappear and current ones are re-applied.
function renderChapter(page = 0) {
  els.bookText.innerHTML = currentChapterHtml();
  // Column height must be the viewport's *content* height (excluding its
  // padding) or the last line of each page column is clipped behind the padding.
  const vpStyle = getComputedStyle(els.viewport);
  const padY = parseFloat(vpStyle.paddingTop) + parseFloat(vpStyle.paddingBottom);
  const padX = parseFloat(vpStyle.paddingLeft) + parseFloat(vpStyle.paddingRight);
  const innerH = els.viewport.clientHeight - padY;
  els.bookText.style.columnWidth = els.viewport.clientWidth - padX + "px";
  els.bookText.style.columnGap = GAP + "px";
  els.bookText.style.height = innerH + "px";
  els.bookText.style.columnFill = "auto";

  pageHighlightState = new Map();
  currentPage = Math.min(Math.max(0, page), getMaxPage());
  renderPage();
  updateHighlights();
  updateChapterLabel();
}

// Re-apply highlights after the dictionary changes (add/remove a word).
export function refreshHighlights() {
  if (!isOpen()) return;
  renderChapter(currentPage);
}

// ---- Pagination (ported) ---------------------------------------------------

function getPageWidth() {
  // One page = one column width + the gap. Read the column width we set on the
  // text element so this stays consistent with renderChapter's padding math.
  const colW = parseFloat(els.bookText.style.columnWidth) || els.viewport.clientWidth;
  return colW + GAP;
}

function getMaxPage() {
  const pages = Math.ceil((els.bookText.scrollWidth - 1) / getPageWidth());
  return Math.max(0, pages - 1);
}

function renderPage() {
  els.bookText.style.transform = `translateX(-${currentPage * getPageWidth()}px)`;
  updateProgress();
  persistLocation();
}

// Flip within the chapter, spilling into adjacent chapters at the boundaries.
function flip(dir) {
  if (dir > 0) {
    if (currentPage < getMaxPage()) {
      currentPage++;
      renderPage();
      updateHighlights();
    } else if (chapterIndex < book.chapters.length - 1) {
      chapterIndex++;
      renderChapter(0);
    }
  } else {
    if (currentPage > 0) {
      currentPage--;
      renderPage();
      updateHighlights();
    } else if (chapterIndex > 0) {
      chapterIndex--;
      renderChapter(Number.MAX_SAFE_INTEGER); // land on last page
    }
  }
}

function updateProgress() {
  const max = getMaxPage();
  els.pageCount.textContent = `Page ${currentPage + 1} of ${max + 1}`;
  const chapters = book.chapters.length;
  const frac =
    (chapterIndex + (max > 0 ? currentPage / (max + 1) : 0)) / chapters;
  els.progressFill.style.width = `${Math.min(100, frac * 100)}%`;
}

function updateChapterLabel() {
  if (els.chapterLabel) {
    els.chapterLabel.textContent =
      book.chapters[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`;
  }
}

function persistLocation() {
  if (book) updateLocation(book.id, { chapter: chapterIndex, page: currentPage });
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

// ---- Highlighting (ported band logic) --------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let highlightQueue = [];
let highlightRunning = false;

function updateHighlights() {
  highlightPage(currentPage); // visible page ready immediately
  queuePrefetch();
}

function highlightPage(p) {
  if (p < 0 || p > getMaxPage()) return;
  const words = Object.keys(getDict());
  if (words.length === 0) return;
  const done = pageHighlightState.get(p) || new Set();
  const pending = words.filter((w) => !done.has(w));
  if (pending.length === 0) return;

  const bandStart = p * getPageWidth();
  const bandEnd = bandStart + (getPageWidth() - GAP); // one column wide
  highlightWordsInBand(pending, bandStart, bandEnd);

  pending.forEach((w) => done.add(w));
  pageHighlightState.set(p, done);
}

function queuePrefetch() {
  const maxPage = getMaxPage();
  const words = Object.keys(getDict());
  if (words.length === 0) return;
  const wanted = [currentPage + 1, currentPage - 1].filter(
    (p) => p >= 0 && p <= maxPage,
  );
  highlightQueue = wanted.filter((p) => {
    const done = pageHighlightState.get(p);
    return words.some((w) => !(done && done.has(w)));
  });
  pumpQueue();
}

function pumpQueue() {
  if (highlightRunning || highlightQueue.length === 0) return;
  highlightRunning = true;
  const run = () => {
    highlightRunning = false;
    const p = highlightQueue.shift();
    if (p === undefined) return;
    highlightPage(p);
    pumpQueue();
  };
  if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 300 });
  else setTimeout(run, 0);
}

// Wrap matches of `words` whose laid-out x-position falls inside the band.
function highlightWordsInBand(words, bandStart, bandEnd) {
  const dict = getDict();
  // Whole-word match using Unicode-aware boundaries (JS \b is ASCII-only and
  // would break inside words like "Wänden"). Letters must not sit on either side.
  const alt = words.map(escapeRegex).join("|");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])(${alt})(?![\\p{L}\\p{N}])`, "giu");
  const originLeft = els.bookText.getBoundingClientRect().left;
  const walker = document.createTreeWalker(els.bookText, NodeFilter.SHOW_TEXT);

  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.classList.contains("custom-highlight")) continue;
    if (!node.textContent.trim()) continue;

    const probe = document.createRange();
    probe.selectNodeContents(node);
    const nodeRect = probe.getBoundingClientRect();
    const nodeLeft = nodeRect.left - originLeft;
    const nodeRight = nodeRect.right - originLeft;
    if (nodeRight < bandStart) continue;
    if (nodeLeft > bandEnd) break;

    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(node.textContent)) !== null) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const matchLeft = range.getBoundingClientRect().left - originLeft;
      if (matchLeft >= bandStart && matchLeft <= bandEnd) {
        ranges.push([range, match[1]]);
      }
    }
  }

  for (const [range, word] of ranges.reverse()) {
    const span = document.createElement("span");
    span.className = "custom-highlight";
    span.dataset.word = word.toLowerCase();
    span.dataset.translation = dict[word.toLowerCase()] || "";
    range.surroundContents(span);
  }
}
