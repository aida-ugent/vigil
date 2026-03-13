/**
 * Shared DOM utilities for content scripts. Single source of truth for
 * platform detection, element lookup, and text normalization within the
 * page context.
 */

import { normalizeWhitespace, genericContentId } from "../shared/utils";

export { normalizeWhitespace };

export function isSupportedTweetHost(hostname: string): boolean {
  return (
    hostname === "twitter.com" ||
    hostname === "www.twitter.com" ||
    hostname === "x.com" ||
    hostname === "www.x.com"
  );
}

export function isTweetPage(): boolean {
  return isSupportedTweetHost(window.location.hostname);
}

/**
 * Finds a tweet `<article>` element by its status ID.
 * Searches all tweet articles for a status URL containing the given ID.
 */
export function findTweetArticle(contentId: string): HTMLElement | null {
  const articles = Array.from(
    document.querySelectorAll('article[data-testid="tweet"]'),
  );
  for (const article of articles) {
    const anchor = article.querySelector(
      'a[href*="/status/"]',
    ) as HTMLAnchorElement | null;
    if (anchor) {
      const m = anchor.href.match(/\/status\/(\d+)/);
      if (m?.[1] === contentId) return article as HTMLElement;
    }
  }
  return null;
}

const GENERIC_BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, blockquote, li, figcaption, [class*='paragraph'], [class*='body-text']";

/**
 * Finds the DOM element for a generic content block. Accepts either a
 * content ID (hash-based, e.g. "g1a2b3c") or the full text.
 * Tries hash comparison first, then falls back to full text match.
 */
export function findGenericElement(
  identifier: string,
): HTMLElement | null {
  const root = findMainContent();
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(GENERIC_BLOCK_SELECTOR),
  );

  const isHashId = identifier.startsWith("g");

  for (const block of blocks) {
    const text = normalizeWhitespace(block.textContent ?? "");
    if (text.length < 10) continue;

    if (isHashId) {
      if (genericContentId(text) === identifier) return block;
    } else {
      if (text === identifier) return block;
    }
  }

  return null;
}

/**
 * Locates the primary content container on the page — article, main,
 * or falls back to document.body.
 */
export function findMainContent(): Element {
  const candidates = [
    document.querySelector("article"),
    document.querySelector('[role="main"]'),
    document.querySelector("main"),
    document.querySelector(".post-content"),
    document.querySelector(".article-content"),
    document.querySelector(".entry-content"),
    document.querySelector(".story-body"),
    document.querySelector("#content"),
  ];

  for (const el of candidates) {
    if (el && el.textContent && el.textContent.trim().length > 200) {
      return el;
    }
  }

  return document.body;
}

/**
 * Finds a content element by ID, dispatching to the appropriate strategy
 * based on whether the current page is a tweet feed or a generic page.
 */
export function findContentElement(contentId: string): HTMLElement | null {
  if (isTweetPage()) return findTweetArticle(contentId);
  return findGenericElement(contentId);
}

export { GENERIC_BLOCK_SELECTOR };
