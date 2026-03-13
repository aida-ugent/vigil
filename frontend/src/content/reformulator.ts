/**
 * Content-script reformulation applier. Replaces page text with reformulated
 * text and supports undo (restore original).
 */

import type { ContentPlatform } from "../shared/content";
import {
  parseTweetHTML,
  reconstructTweetHTML,
  computeChangedIndices,
  type ReformulationSegment,
} from "./tweetParser";
import { isTweetPage, findTweetArticle, findGenericElement } from "./domUtils";

interface StoredOriginal {
  html: string;
  platform: ContentPlatform;
}

const originals = new Map<string, StoredOriginal>();

const CSS_REFORMULATED = "vigil-reformulated";
const CSS_REFORM_BADGE = "vigil-reform-badge";

// ── Twitter helpers ──

function addReformulatedBadge(postElement: HTMLElement): void {
  if (postElement.querySelector(`.${CSS_REFORM_BADGE}`)) return;

  clearStatusBadges(postElement);
  postElement.style.borderLeft = "3px solid #16a34a";

  const textEl = postElement.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
  const anchor = textEl ?? postElement;

  const tag = document.createElement("div");
  tag.className = CSS_REFORM_BADGE;
  tag.style.cssText =
    "display:inline-flex;align-items:center;gap:3px;margin-top:6px;" +
    "color:#16a34a;font-size:11px;font-weight:500;pointer-events:none;";
  tag.innerHTML =
    '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
    'd="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>' +
    "</svg>" +
    '<span style="line-height:1">Reformulated by Vigil</span>';

  anchor.parentElement?.insertBefore(tag, anchor.nextSibling);
}

function underlineChangedSegments(container: HTMLElement, indices: number[]): void {
  for (const i of indices) {
    const segEl = container.querySelector(`[data-vigil-seg="${i}"]`) as HTMLElement | null;
    if (!segEl || segEl.querySelector(`.${CSS_REFORMULATED}`)) continue;
    const wrap = document.createElement("span");
    wrap.className = CSS_REFORMULATED;
    wrap.title = "Reformulated";
    while (segEl.firstChild) wrap.appendChild(segEl.firstChild);
    segEl.appendChild(wrap);
  }
}

// ── Public API ──

export function applyReformulation(
  contentId: string,
  reformulatedText: string,
  segments?: ReformulationSegment[],
  changedIndices?: number[],
): boolean {
  if (isTweetPage()) {
    return applyTwitterReformulation(contentId, reformulatedText, segments, changedIndices);
  }
  return applyGenericReformulation(contentId, reformulatedText);
}

function applyTwitterReformulation(
  contentId: string,
  reformulatedText: string,
  segments?: ReformulationSegment[],
  changedIndices?: number[],
): boolean {
  const article = findTweetArticle(contentId);
  if (!article) return false;

  const textContainer = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
  if (!textContainer) return false;

  originals.set(contentId, {
    html: textContainer.outerHTML,
    platform: "twitter",
  });

  if (segments && segments.length > 0) {
    const originalParsed = parseTweetHTML(textContainer);
    const newContainer = reconstructTweetHTML(segments, textContainer);
    const indices = changedIndices ?? computeChangedIndices(originalParsed.segments, segments);
    textContainer.parentElement?.replaceChild(newContainer, textContainer);
    underlineChangedSegments(newContainer, indices);
  } else {
    textContainer.textContent = reformulatedText;
  }

  article.dataset.vigilReformApplied = "true";
  addReformulatedBadge(article);
  return true;
}

function applyGenericReformulation(
  contentId: string,
  reformulatedText: string,
): boolean {
  const el = findGenericElement(contentId);
  if (!el) return false;

  originals.set(contentId, {
    html: el.innerHTML,
    platform: "generic",
  });

  el.textContent = reformulatedText;
  el.dataset.vigilReformApplied = "true";
  return true;
}

export function restoreOriginal(contentId: string): boolean {
  const stored = originals.get(contentId);
  if (!stored) return false;

  if (stored.platform === "twitter") {
    return restoreTwitter(contentId, stored);
  }
  return restoreGeneric(contentId, stored);
}

function restoreTwitter(contentId: string, stored: StoredOriginal): boolean {
  const article = findTweetArticle(contentId);
  if (!article) return false;

  let textEl = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
  if (!textEl) {
    textEl = article.querySelector("[data-vigil-seg]")?.closest("div[dir]") as HTMLElement | null;
  }
  if (!textEl) return false;

  const temp = document.createElement("div");
  temp.innerHTML = stored.html;
  const restoredEl = temp.firstElementChild as HTMLElement | null;
  if (restoredEl) {
    textEl.parentElement?.replaceChild(restoredEl, textEl);
  } else {
    textEl.innerHTML = stored.html;
  }

  delete article.dataset.vigilReformApplied;
  article.style.borderLeft = "";
  article.querySelector(`.${CSS_REFORM_BADGE}`)?.remove();
  originals.delete(contentId);
  return true;
}

function restoreGeneric(contentId: string, stored: StoredOriginal): boolean {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-vigil-reform-applied]"));
  for (const el of candidates) {
    el.innerHTML = stored.html;
    delete el.dataset.vigilReformApplied;
    originals.delete(contentId);
    return true;
  }
  return false;
}

export function hasReformulation(contentId: string): boolean {
  return originals.has(contentId);
}

// ── Analysis status badges ──

const CSS_VERIFIED_BADGE = "vigil-verified-badge";
const CSS_ANALYZED_BADGE = "vigil-analyzed-badge";
const ALL_STATUS_BADGES = [CSS_VERIFIED_BADGE, CSS_ANALYZED_BADGE];

const CHECKMARK_SVG =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';

const ALERT_SVG =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
  'd="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>';

/** Removes any existing Vigil status badges from an element. */
function clearStatusBadges(root: HTMLElement): void {
  for (const cls of ALL_STATUS_BADGES) {
    root.querySelector(`.${cls}`)?.remove();
  }
  if (root.style.borderLeft.includes("solid")) root.style.borderLeft = "";
}

interface BadgeConfig {
  className: string;
  color: string;
  borderColor: string;
  icon: string;
  label: string;
}

function attachBadge(contentId: string, config: BadgeConfig): boolean {
  if (isTweetPage()) {
    const article = findTweetArticle(contentId);
    if (!article) return false;
    clearStatusBadges(article);
    article.style.borderLeft = `3px solid ${config.borderColor}`;

    const textEl = article.querySelector('[data-testid="tweetText"]') as HTMLElement | null;
    const anchor = textEl ?? article;

    const tag = document.createElement("div");
    tag.className = config.className;
    tag.style.cssText =
      "display:inline-flex;align-items:center;gap:3px;margin-top:6px;" +
      `color:${config.color};font-size:11px;font-weight:500;pointer-events:none;`;
    tag.innerHTML = config.icon + `<span style="line-height:1">${config.label}</span>`;
    anchor.parentElement?.insertBefore(tag, anchor.nextSibling);
    return true;
  }

  const el = findGenericElement(contentId);
  if (!el) return false;
  clearStatusBadges(el);

  const tag = document.createElement("div");
  tag.className = config.className;
  tag.style.cssText =
    "display:inline-flex;align-items:center;gap:3px;margin-top:4px;" +
    `color:${config.color};font-size:11px;font-weight:500;pointer-events:none;`;
  tag.innerHTML = config.icon + `<span style="line-height:1">${config.label}</span>`;
  el.appendChild(tag);
  return true;
}

export function addVerifiedBadge(contentId: string): boolean {
  return attachBadge(contentId, {
    className: CSS_VERIFIED_BADGE,
    color: "#0891b2",
    borderColor: "#0891b2",
    icon: CHECKMARK_SVG,
    label: "Verified by Vigil",
  });
}

export function addAnalyzedBadge(contentId: string, count: number): boolean {
  const noun = count === 1 ? "trigger" : "triggers";
  return attachBadge(contentId, {
    className: CSS_ANALYZED_BADGE,
    color: "#d97706",
    borderColor: "#d97706",
    icon: ALERT_SVG,
    label: `${count} bias ${noun} detected by Vigil`,
  });
}
