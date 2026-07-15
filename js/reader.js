// reader.js — the reading view. Each chapter is paginated in JavaScript into
// discrete, page-sized boxes laid out in a horizontal row; flipping shifts the
// row with translateX. Unlike CSS multi-column pagination, every page is real
// normal-flow content (a paragraph that spans a page break is split into two
// separate <p> elements), so iOS Safari can select any word — the continuation
// of a paragraph is a genuine element, not an un-hittable column fragment.

import { getBook, getDict, updateLocation } from "./storage.js";

// Gutter between page boxes. Must exceed the viewport's side padding, or a
// neighboring page peeks through the current page's left/right margin.
const GAP = 48;

let els = null; // cached DOM references, filled on init
let book = null; // active book object
let chapterIndex = 0;

// Pagination state for the current chapter.
let pages = []; // [{ firstBlock }] — index of the first source block on each page
let currentPage = 0;
let pageW = 0; // page content width (px)
let pageH = 0; // page content height (px)
let roLastW = -1, roLastH = -1; // last viewport size the chapter was paginated at

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

  // Re-paginate whenever the viewport actually changes size (window resize,
  // rotate, sidebar toggles). A ResizeObserver on the viewport is more reliable
  // than the window "resize" event and reads the real box, so widening after
  // narrowing correctly reflows the text back out.
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    if (!book || els.view.classList.contains("hidden")) return;
    const w = els.viewport.clientWidth, h = els.viewport.clientHeight;
    if (w === roLastW && h === roLastH) return; // no real change
    clearTimeout(resizeTimer);
    const anchor = pages[currentPage]?.firstBlock ?? 0;
    resizeTimer = setTimeout(() => paginateChapter(anchor), 150);
  });
  ro.observe(els.viewport);

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
  els.viewport.addEventListener("click", (e) => {
    if (e.target.closest(".custom-highlight")) return; // highlight menu handles it
    if (e.target.closest(".page-button")) return; // flip arrows
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // mid text-selection
    toggleChrome();
  });
  els.view.querySelector(".reader-bar")?.addEventListener("click", () => {
    if (els.view.classList.contains("chrome-visible")) showChrome();
  });
}

// Horizontal swipe flips pages (primary flip gesture on touch devices).
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
  // Kill vertical scroll/rubber-band attempts while swiping the page. CSS
  // touch-action:pan-x covers modern iOS; this handles the rest. Selection
  // drags are exempt so iOS can still move the native selection handles.
  els.viewport.addEventListener(
    "touchmove",
    (e) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
    },
    { passive: false },
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
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // don't flip mid-selection
      flip(dx < 0 ? +1 : -1);
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
  // Position within a chapter is stored as the index of the first source block
  // (paragraph) shown — device-independent, unlike a raw page number.
  const startBlock = book.lastLocation?.page || 0;
  els.title.textContent = book.title;
  buildContentsMenu();
  // The view must already be visible so the viewport has real dimensions to
  // measure — the caller (main.js) reveals the reader before calling openBook.
  els.view.classList.remove("hidden");
  hideChrome(); // start with chrome hidden (Apple Books style, mobile)
  paginateChapter(startBlock);
}

function currentChapterHtml() {
  const ch = book.chapters[chapterIndex];
  if (!ch) return "";
  if (ch.html) return ch.html;
  // Legacy chapters stored as plain text: escape and wrap in a paragraph.
  const esc = (ch.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return "<p>" + esc.replace(/\n\s*\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
}

// ---- Pagination ------------------------------------------------------------

function newPageEl() {
  const p = document.createElement("div");
  p.className = "reader-page";
  p.style.width = pageW + "px";
  p.style.height = pageH + "px";
  return p;
}

// Split the current chapter into page boxes and land on the page containing
// `targetBlock` (a source-block index; a large value lands on the last page).
// Runs synchronously, so the browser never paints the intermediate states.
function paginateChapter(targetBlock = 0) {
  const row = els.bookText;
  row.classList.remove("slide");
  // Clear any inline styles left by earlier layout schemes so the flex row is clean.
  row.style.cssText = "";
  row.style.transform = "translateX(0)";
  row.style.columnGap = GAP + "px"; // gutter between page boxes
  row.innerHTML = "";

  const vpStyle = getComputedStyle(els.viewport);
  const padX = parseFloat(vpStyle.paddingLeft) + parseFloat(vpStyle.paddingRight);
  const padY = parseFloat(vpStyle.paddingTop) + parseFloat(vpStyle.paddingBottom);
  pageW = els.viewport.clientWidth - padX;
  pageH = els.viewport.clientHeight - padY;
  roLastW = els.viewport.clientWidth;
  roLastH = els.viewport.clientHeight;

  // Parse the chapter into its top-level block elements.
  const source = document.createElement("div");
  source.innerHTML = currentChapterHtml();
  const queue = Array.from(source.children).map((node, i) => ({ node, block: i }));

  pages = [];
  let pageEl = newPageEl();
  let pageFirst = -1; // source-block index of the first content on this page
  row.appendChild(pageEl);

  const pushPage = () => pages.push({ firstBlock: pageFirst < 0 ? 0 : pageFirst });
  const nextPage = () => {
    pushPage();
    pageEl = newPageEl();
    row.appendChild(pageEl);
    pageFirst = -1;
  };

  while (queue.length) {
    const { node, block } = queue.shift();
    pageEl.appendChild(node);

    if (pageEl.scrollHeight <= pageH + 1) {
      if (pageFirst < 0) pageFirst = block; // first content on this page
      continue; // fits fully — keep filling
    }

    // Overflowed. Pull the block back out.
    pageEl.removeChild(node);

    // Headings/titles are kept whole — never split across a page break.
    if (isUnsplittable(node)) {
      if (pageEl.childNodes.length > 0) {
        nextPage();
        queue.unshift({ node, block }); // retry the whole heading on a fresh page
      } else {
        pageEl.appendChild(node); // taller than a page (rare) — place it clipped
        if (pageFirst < 0) pageFirst = block;
        nextPage();
      }
      continue;
    }

    // Otherwise split it to fill the *remaining* space; the rest continues next page.
    const { placed, tail } = splitBlock(node, pageEl);

    if (placed) {
      if (pageFirst < 0) pageFirst = block; // head is the first content
      nextPage();
      if (tail) queue.unshift({ node: tail, block }); // continuation, same block
    } else if (pageEl.childNodes.length > 0) {
      // No line fit in the leftover space — finish this page, retry on a fresh one.
      nextPage();
      queue.unshift({ node, block });
    } else {
      // Empty page and not even one line fits (pathological) — place it clipped.
      pageEl.appendChild(node);
      if (pageFirst < 0) pageFirst = block;
      nextPage();
    }
  }
  // Push the final page unless nextPage() just left an empty trailing one.
  if (pageEl.childNodes.length > 0 || pages.length === 0) pushPage();

  applyHighlights(); // wrap dictionary words across every page (box-shadow: no reflow)
  updateChapterLabel();

  // Land on the first page that starts at/after targetBlock (targetBlock is a
  // stored firstBlock value, so this hits its page exactly). A huge value — used
  // by "previous chapter" — matches nothing and falls through to the last page.
  const idx = pages.findIndex((p) => p.firstBlock >= targetBlock);
  currentPage = idx === -1 ? pages.length - 1 : idx;
  showPage(false);
}

// Headings and title-like blocks (a big font-size the EPUB gave them) are moved
// whole rather than split across a page break.
function isUnsplittable(node) {
  if (/^H[1-6]$/.test(node.tagName)) return true;
  const fs = node.style && node.style.fontSize;
  if (fs && fs.endsWith("em") && parseFloat(fs) >= 1.3) {
    // A big font-size marks a title only when the text is short; a long block in
    // large print is still real body text and may be split across pages.
    return (node.textContent || "").trim().length < 200;
  }
  return false;
}

// Split `block` so its head fills the space left on `pageEl` (after whatever is
// already there) and the remainder is returned to continue on the next page.
// Preserves inline formatting via Range.cloneContents. Returns
// { placed, tail }: placed=false means not even one line fit in the leftover
// space (the block is removed again so the caller can retry it on a fresh page).
function splitBlock(block, pageEl) {
  pageEl.appendChild(block);
  const limit = pageEl.getBoundingClientRect().top + pageH;

  const texts = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) texts.push(n);
  const totalLen = texts.reduce((s, t) => s + t.length, 0);
  if (totalLen === 0) { pageEl.removeChild(block); return { placed: false, tail: null }; }

  const charToPoint = (idx) => {
    let i = idx, k = 0;
    while (k < texts.length && i > texts[k].length) { i -= texts[k].length; k++; }
    if (k >= texts.length) { k = texts.length - 1; i = texts[k].length; }
    return [texts[k], i];
  };

  const probe = document.createRange();
  const fits = (idx) => {
    const [node, off] = charToPoint(idx);
    probe.setStart(block, 0);
    probe.setEnd(node, off);
    const rects = probe.getClientRects();
    return rects.length === 0 || rects[rects.length - 1].bottom <= limit;
  };

  // Largest prefix (in characters) that still fits vertically.
  let lo = 1, hi = totalLen, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best <= 0) { pageEl.removeChild(block); return { placed: false, tail: null }; }

  // Snap the cut back to a word boundary so no word is broken across pages.
  const full = texts.map((t) => t.data).join("");
  let cut = best;
  while (cut > 0 && !/\s/.test(full[cut - 1])) cut--;
  if (cut <= 0) cut = best; // single word longer than a page — hard cut

  const [cutNode, cutOff] = charToPoint(cut);

  const headRange = document.createRange();
  headRange.setStart(block, 0);
  headRange.setEnd(cutNode, cutOff);
  const head = block.cloneNode(false);
  head.appendChild(headRange.cloneContents());

  const tailRange = document.createRange();
  tailRange.setStart(cutNode, cutOff);
  tailRange.setEnd(block, block.childNodes.length);
  const tail = block.cloneNode(false);
  tail.classList.add("cont"); // continuation → no first-line indent
  tail.appendChild(tailRange.cloneContents());

  pageEl.removeChild(block);
  pageEl.appendChild(head);
  return { placed: true, tail: tail.textContent.trim() ? tail : null };
}

// ---- Flip / navigation -----------------------------------------------------

function showPage(animate) {
  els.bookText.classList.toggle("slide", animate);
  els.bookText.style.transform = `translateX(${-currentPage * (pageW + GAP)}px)`;
  updateProgress();
  persistLocation();
}

// Flip within the chapter, spilling into adjacent chapters at the boundaries.
function flip(dir) {
  if (dir > 0) {
    if (currentPage < pages.length - 1) {
      currentPage++;
      showPage(true);
    } else if (chapterIndex < book.chapters.length - 1) {
      flipChapter(chapterIndex + 1, 0, +1);
    }
  } else {
    if (currentPage > 0) {
      currentPage--;
      showPage(true);
    } else if (chapterIndex > 0) {
      flipChapter(chapterIndex - 1, Number.MAX_SAFE_INTEGER, -1); // land on the last page
    }
  }
}

// Cross-chapter flip with the same slide animation as an in-chapter flip.
// The outgoing page can't just translate away — repaginating replaces the whole
// row — so freeze a clone of it over the viewport, build the new chapter, start
// the new page one slot off to the side, then slide both in tandem: visually a
// single continuous row, exactly like flipping within a chapter.
function flipChapter(newIndex, targetBlock, dir) {
  // 1. Snapshot the outgoing page at its current spot inside the viewport.
  const vpStyle = getComputedStyle(els.viewport);
  const snap = document.createElement("div");
  snap.className = "page-snap";
  snap.style.left = vpStyle.paddingLeft;
  snap.style.top = vpStyle.paddingTop;
  const outgoing = els.bookText.children[currentPage];
  if (outgoing) snap.appendChild(outgoing.cloneNode(true));
  els.viewport.appendChild(snap);

  // 2. Build the new chapter and land on its target page (synchronous — the
  //    intermediate, un-offset state is never painted).
  chapterIndex = newIndex;
  paginateChapter(targetBlock);

  // 3. Slide: incoming row starts one page slot beyond its target; the snapshot
  //    exits toward the opposite side at the same speed.
  const row = els.bookText;
  const step = pageW + GAP;
  const target = -currentPage * step;
  row.style.transform = `translateX(${target + dir * step}px)`;
  void row.offsetWidth; // commit the start positions before animating
  row.classList.add("slide");
  row.style.transform = `translateX(${target}px)`;
  snap.classList.add("slide");
  snap.style.transform = `translateX(${-dir * step}px)`;
  snap.addEventListener("transitionend", () => snap.remove(), { once: true });
  setTimeout(() => snap.remove(), 600); // fallback (e.g. reduced-motion: no event)
}

function updateProgress() {
  const total = pages.length;
  els.pageCount.textContent = `Page ${currentPage + 1} of ${total}`;
  const chapters = book.chapters.length;
  const frac = (chapterIndex + (total > 0 ? currentPage / total : 0)) / chapters;
  els.progressFill.style.width = `${Math.min(100, frac * 100)}%`;
}

function updateChapterLabel() {
  if (els.chapterLabel) {
    els.chapterLabel.textContent =
      book.chapters[chapterIndex]?.title || `Chapter ${chapterIndex + 1}`;
  }
}

function persistLocation() {
  if (!book) return;
  const total = pages.length;
  const chapters = book.chapters.length;
  // Overall reading fraction (chapter + position within it) — shown as the
  // progress bar on the library's Reading Now card. Stored locally only; the
  // synced reading_progress row still carries just chapter/page.
  const progress = chapters
    ? (chapterIndex + (total > 0 ? currentPage / total : 0)) / chapters
    : 0;
  updateLocation(book.id, {
    chapter: chapterIndex,
    page: pages[currentPage]?.firstBlock ?? 0,
    progress,
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
      paginateChapter(0);
      els.contentsPanel.classList.add("hidden");
    });
    list.appendChild(li);
  });
}

// ---- Highlighting ----------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Re-paginate the current chapter after the dictionary changes, keeping place.
export function refreshHighlights() {
  if (!isOpen()) return;
  paginateChapter(pages[currentPage]?.firstBlock ?? 0);
}

// Wrap every dictionary word across all page boxes of the current chapter. The
// highlight style is a box-shadow (see CSS), so wrapping never changes layout —
// safe to run after pagination without disturbing the page breaks.
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

  // Wrap in reverse so surrounding one match doesn't invalidate earlier offsets
  // in the same text node.
  for (const [range, word] of ranges.reverse()) {
    const span = document.createElement("span");
    span.className = "custom-highlight";
    span.dataset.word = word.toLowerCase();
    span.dataset.translation = dict[word.toLowerCase()] || "";
    range.surroundContents(span);
  }
}
