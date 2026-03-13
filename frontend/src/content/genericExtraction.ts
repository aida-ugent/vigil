import type { ContentExtractionResult, ContentItem } from "../shared/content";
import { normalizeWhitespace, genericContentId } from "../shared/utils";
import {
  isTweetPage,
  findMainContent,
  findGenericElement,
  GENERIC_BLOCK_SELECTOR,
} from "./domUtils";

const MIN_TEXT_LENGTH = 80;
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEXTAREA", "INPUT",
  "CODE", "PRE", "SVG", "NAV", "FOOTER", "HEADER",
]);

/**
 * Extracts distinct content blocks (paragraphs, headings, blockquotes) from
 * the main content area. Each block with sufficient text becomes a ContentItem.
 * Works for news sites, blog posts, and generic article pages.
 */
function extractContentBlocks(root: Element, pageUrl: string): ContentItem[] {
  const items: ContentItem[] = [];
  const seen = new Set<string>();
  const blocks = Array.from(root.querySelectorAll(GENERIC_BLOCK_SELECTOR));

  for (const block of blocks) {
    if (SKIP_TAGS.has(block.tagName)) continue;
    if (block.closest("nav, footer, header, aside, [role='navigation']")) continue;

    const text = normalizeWhitespace(block.textContent ?? "");
    if (text.length < MIN_TEXT_LENGTH) continue;

    const id = genericContentId(text);
    if (seen.has(id)) continue;
    seen.add(id);

    items.push({
      id,
      text,
      platform: "generic",
      pageUrl,
    });
  }

  if (items.length === 0) {
    const bodyText = normalizeWhitespace(root.textContent ?? "");
    if (bodyText.length >= MIN_TEXT_LENGTH) {
      const truncated = bodyText.length > 2000 ? bodyText.slice(0, 2000) : bodyText;
      items.push({
        id: genericContentId(truncated),
        text: truncated,
        platform: "generic",
        pageUrl,
      });
    }
  }

  return items;
}

export function isGenericPage(): boolean {
  return !isTweetPage();
}

export function extractGenericContent(): ContentExtractionResult {
  const startedAt = performance.now();
  const root = findMainContent();
  const items = extractContentBlocks(root, window.location.href);

  return {
    items,
    platform: "generic",
    pageUrl: window.location.href,
    elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

export { findGenericElement };
