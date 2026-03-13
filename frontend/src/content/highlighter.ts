import { formatFindingMeta, type Finding } from "../shared/findings";
import type { HighlightResult } from "../shared/platform";
import type { ContentAnalysisResult } from "../shared/content";

/** Internal to the tweet highlight path. Rest of codebase uses ContentAnalysisResult. */
interface TweetAnalysisResult {
  tweetId: string;
  text: string;
  findings: Finding[];
  tips: string[];
  elapsedMs: number;
}
import { normalizeWhitespace, tweetFallbackId } from "../shared/utils";
import { findTweetArticle, findGenericElement } from "./domUtils";

const STYLE_ID = "vigil-highlight-styles";
const HIGHLIGHT_CLASS = "vigil-highlight";
const TOOLTIP_CLASS = "vigil-tooltip";
const TOOLTIP_ROOT_ID = "vigil-tooltip-root";
const HIGHLIGHT_DATA_ATTR = "data-vigil-highlight";

const VIEWPORT_MARGIN = 8;
const TOOLTIP_GAP = 10;

/** Highlight marks live in light DOM (they wrap existing text), scoped by class name. */
const HIGHLIGHT_CSS = `
.${HIGHLIGHT_CLASS} {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  cursor: pointer;
  border-radius: 2px;
  padding: 0 1px;
}
.${HIGHLIGHT_CLASS}[data-severity="high"] {
  text-decoration-color: #e53e3e;
  background-color: rgba(229, 62, 62, 0.10);
}
.${HIGHLIGHT_CLASS}[data-severity="medium"] {
  text-decoration-color: #dd6b20;
  background-color: rgba(221, 107, 32, 0.08);
}
.${HIGHLIGHT_CLASS}[data-severity="low"] {
  text-decoration-color: #d69e2e;
  background-color: rgba(214, 158, 46, 0.08);
}
`;

function injectHighlightStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HIGHLIGHT_CSS;
  document.head.appendChild(style);
}

function removeHighlightStyles(): void {
  document.getElementById(STYLE_ID)?.remove();
}

let tooltipListenersBound = false;
let shadowHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let globalTooltip: HTMLDivElement | null = null;

const TOOLTIP_SHADOW_CSS = `
.${TOOLTIP_CLASS} {
  display: none;
  position: fixed;
  width: max-content;
  max-width: 280px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #ffffff;
  color: #0f1419;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 2px 12px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04);
  z-index: 2147483647;
  pointer-events: none;
  white-space: normal;
}
.${TOOLTIP_CLASS} strong {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.${TOOLTIP_CLASS} strong[data-severity="high"] { color: #e53e3e; }
.${TOOLTIP_CLASS} strong[data-severity="medium"] { color: #dd6b20; }
.${TOOLTIP_CLASS} strong[data-severity="low"] { color: #b7791f; }
.${TOOLTIP_CLASS} .tooltip-meta {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: #536471;
  font-style: italic;
}
`;

function ensureGlobalTooltip(): HTMLDivElement {
  if (globalTooltip && shadowHost && document.contains(shadowHost)) {
    return globalTooltip;
  }

  shadowHost?.remove();

  const host = document.createElement("div");
  host.id = TOOLTIP_ROOT_ID;
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = TOOLTIP_SHADOW_CSS;
  root.appendChild(style);

  const tooltip = document.createElement("div");
  tooltip.className = TOOLTIP_CLASS;
  root.appendChild(tooltip);

  document.body.appendChild(host);
  shadowHost = host;
  shadowRoot = root;
  globalTooltip = tooltip;
  return tooltip;
}

function hideGlobalTooltip(): void {
  if (globalTooltip) {
    globalTooltip.style.display = "none";
  }
}

function showTooltipForMark(mark: Element): void {
  const tooltip = ensureGlobalTooltip();
  const label = mark.getAttribute("data-label") ?? "Trigger";
  const explanation = mark.getAttribute("data-explanation") ?? "";
  const severity = mark.getAttribute("data-severity") ?? "low";
  const meta = mark.getAttribute("data-meta");

  tooltip.replaceChildren();
  const strong = document.createElement("strong");
  strong.setAttribute("data-severity", severity);
  strong.textContent = label;
  tooltip.appendChild(strong);
  tooltip.appendChild(document.createTextNode(explanation));

  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "tooltip-meta";
    metaEl.textContent = meta;
    tooltip.appendChild(metaEl);
  }

  positionTooltip(mark, tooltip);
}

function positionTooltip(mark: Element, tooltip: HTMLElement): void {
  const rect = mark.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  tooltip.style.display = "block";
  tooltip.style.left = "0";
  tooltip.style.top = "0";

  const tipRect = tooltip.getBoundingClientRect();

  let left = rect.left + (rect.width - tipRect.width) / 2;
  if (left + tipRect.width > vw - VIEWPORT_MARGIN) {
    left = vw - tipRect.width - VIEWPORT_MARGIN;
  }
  if (left < VIEWPORT_MARGIN) {
    left = VIEWPORT_MARGIN;
  }

  let top = rect.bottom + TOOLTIP_GAP;
  if (top + tipRect.height > vh - VIEWPORT_MARGIN) {
    top = rect.top - tipRect.height - TOOLTIP_GAP;
  }
  if (top < VIEWPORT_MARGIN) {
    top = VIEWPORT_MARGIN;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function bindTooltipListeners(): void {
  if (tooltipListenersBound) return;
  tooltipListenersBound = true;

  document.addEventListener("mouseenter", (e) => {
    const mark = (e.target as Element).closest?.(`.${HIGHLIGHT_CLASS}`);
    if (!mark) return;
    showTooltipForMark(mark);
  }, true);

  document.addEventListener("mouseleave", (e) => {
    const mark = (e.target as Element).closest?.(`.${HIGHLIGHT_CLASS}`);
    if (!mark) return;
    hideGlobalTooltip();
  }, true);
}

/**
 * Finds the tweet article element matching a tweetId. Tries status-URL matching
 * first, then falls back to text-hash matching.
 */
function findTweetElement(
  tweetId: string,
  text: string,
): Element | null {
  const byId = findTweetArticle(tweetId);
  if (byId) return byId;

  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  for (const article of articles) {
    const tweetText = article.querySelector('[data-testid="tweetText"]');
    if (!tweetText?.textContent) continue;
    const normalized = normalizeWhitespace(tweetText.textContent);
    if (tweetFallbackId(normalized) === tweetId || normalized === text) {
      return article;
    }
  }

  return null;
}

interface TextNodeSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * Builds a flat map of text nodes under an element to their character offset
 * ranges in the raw concatenated text.
 */
function buildTextNodeMap(container: Element): TextNodeSegment[] {
  const segments: TextNodeSegment[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;

  let node = walker.nextNode() as Text | null;
  while (node) {
    const raw = node.nodeValue ?? "";
    if (raw.length > 0) {
      const len = raw.length;
      segments.push({ node, start: offset, end: offset + len });
      offset += len;
    }
    node = walker.nextNode() as Text | null;
  }

  return segments;
}

/**
 * Builds a mapping from character positions in whitespace-normalized text
 * back to positions in the raw concatenated text. Mirrors normalizeWhitespace:
 * trim leading/trailing whitespace, collapse internal \s+ → single space.
 *
 * Returns an array where map[normalizedIndex] = rawIndex.
 * Length is normalizedLength + 1 (extra sentinel for exclusive span ends).
 */
function buildNormalizedToRawMap(rawText: string): number[] {
  const map: number[] = [];
  let ri = 0;

  while (ri < rawText.length && /\s/.test(rawText[ri])) ri++;

  while (ri < rawText.length) {
    if (/\s/.test(rawText[ri])) {
      map.push(ri);
      while (ri < rawText.length && /\s/.test(rawText[ri])) ri++;
    } else {
      map.push(ri);
      ri++;
    }
  }

  // Trim trailing: if the last normalized char was a space from trailing
  // whitespace, remove it (normalizeWhitespace trims both ends).
  if (map.length > 0) {
    const lastRaw = map[map.length - 1];
    if (/\s/.test(rawText[lastRaw])) {
      map.pop();
    }
  }

  map.push(ri);
  return map;
}

/**
 * Wraps a character range [spanStart, spanEnd) across potentially multiple text
 * nodes with a highlight <mark> element.
 */
function wrapSpan(
  segments: TextNodeSegment[],
  spanStart: number,
  spanEnd: number,
  finding: Finding,
): boolean {
  const affectedSegments = segments.filter(
    (s) => s.end > spanStart && s.start < spanEnd,
  );

  if (affectedSegments.length === 0) {
    return false;
  }

  const wrapper = document.createElement("mark");
  wrapper.className = HIGHLIGHT_CLASS;
  wrapper.setAttribute("data-severity", finding.severity);
  wrapper.setAttribute("data-label", finding.label);
  wrapper.setAttribute("data-explanation", finding.explanation);
  wrapper.setAttribute(HIGHLIGHT_DATA_ATTR, "true");
  const metaStr = formatFindingMeta(finding);
  if (metaStr) wrapper.setAttribute("data-meta", metaStr);

  const firstSeg = affectedSegments[0];
  const localStart = Math.max(0, spanStart - firstSeg.start);

  if (localStart > 0) {
    firstSeg.node.splitText(localStart);
    const newNode = firstSeg.node.nextSibling as Text;
    const oldEnd = firstSeg.end;
    firstSeg.end = firstSeg.start + localStart;
    const newSegment: TextNodeSegment = {
      node: newNode,
      start: firstSeg.end,
      end: oldEnd,
    };
    const idx = segments.indexOf(firstSeg);
    segments.splice(idx + 1, 0, newSegment);
    affectedSegments[0] = newSegment;
  }

  const lastSeg = affectedSegments[affectedSegments.length - 1];
  const localEnd = spanEnd - lastSeg.start;

  if (localEnd < lastSeg.node.length) {
    lastSeg.node.splitText(localEnd);
    lastSeg.end = lastSeg.start + localEnd;
  }

  const firstNode = affectedSegments[0].node;
  firstNode.parentNode!.insertBefore(wrapper, firstNode);

  for (const seg of affectedSegments) {
    wrapper.appendChild(seg.node);
  }

  return true;
}

/**
 * Highlights findings within a single text element.
 * Span offsets in findings are relative to normalized text (trimmed, collapsed
 * whitespace). This function maps them back to raw DOM offsets before wrapping.
 */
function highlightSpansInElement(
  textEl: Element,
  findings: Finding[],
): number {
  const withSpans = findings.filter(
    (f) => f.spanStart != null && f.spanEnd != null,
  );
  if (withSpans.length === 0) {
    return 0;
  }

  const initialSegments = buildTextNodeMap(textEl);
  const rawText = initialSegments.map(s => s.node.nodeValue ?? "").join("");
  const nToR = buildNormalizedToRawMap(rawText);

  const converted = withSpans
    .map(f => ({
      finding: f,
      rawStart: nToR[Math.min(f.spanStart!, nToR.length - 1)],
      rawEnd: nToR[Math.min(f.spanEnd!, nToR.length - 1)],
    }))
    .sort((a, b) => b.rawStart - a.rawStart);

  let count = 0;
  for (const { finding, rawStart, rawEnd } of converted) {
    if (rawStart >= rawEnd) continue;
    const segments = buildTextNodeMap(textEl);
    if (wrapSpan(segments, rawStart, rawEnd, finding)) {
      count++;
    }
  }

  return count;
}

export function highlightTweetFindings(
  results: TweetAnalysisResult[],
): HighlightResult {
  clearAllHighlights();
  injectHighlightStyles();
  bindTooltipListeners();

  let highlightedItems = 0;
  let totalHighlights = 0;

  for (const result of results) {
    if (result.findings.length === 0) continue;

    const article = findTweetElement(result.tweetId, result.text);
    if (!article) continue;

    const tweetText = article.querySelector('[data-testid="tweetText"]');
    if (!tweetText) continue;

    const count = highlightSpansInElement(tweetText, result.findings);
    if (count > 0) {
      highlightedItems++;
      totalHighlights += count;
    }
  }

  return { highlightedItems, totalHighlights };
}

/**
 * Highlights findings in generic (non-tweet) content items by locating each
 * content block's DOM element and applying the same span-wrapping logic.
 */
export function highlightContentFindings(
  results: ContentAnalysisResult[],
): HighlightResult {
  clearAllHighlights();
  injectHighlightStyles();
  bindTooltipListeners();

  let highlightedItems = 0;
  let totalHighlights = 0;

  for (const result of results) {
    if (result.findings.length === 0) continue;

    const element = findGenericElement(result.text);
    if (!element) continue;

    const count = highlightSpansInElement(element, result.findings);
    if (count > 0) {
      highlightedItems++;
      totalHighlights += count;
    }
  }

  return { highlightedItems, totalHighlights };
}

export function clearAllHighlights(): void {
  hideGlobalTooltip();
  shadowHost?.remove();
  shadowHost = null;
  shadowRoot = null;
  globalTooltip = null;

  const marks = Array.from(document.querySelectorAll(`mark[${HIGHLIGHT_DATA_ATTR}]`));

  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;

    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }

  removeHighlightStyles();
}
