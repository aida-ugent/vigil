/**
 * Pure utility functions shared across all extension contexts.
 * Must not reference context-specific APIs (no chrome.tabs, no DOM, etc.).
 */

/** DJB2-variant hash. Returns a hex string (no prefix). */
export function djb2Hash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

/** Collapse runs of whitespace to a single space and trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Generate a content ID for a generic (non-tweet) content block.
 * Normalizes whitespace before hashing for stable identity.
 */
export function genericContentId(text: string): string {
  return `g${djb2Hash(normalizeWhitespace(text))}`;
}

/**
 * Fallback tweet ID when no status URL is available.
 * Uses the raw text hash (not normalized) for backward compat.
 */
export function tweetFallbackId(text: string): string {
  return `h${djb2Hash(text)}`;
}

/**
 * Hash used for cache validation (text changed since last analysis?).
 * Normalizes before hashing so insignificant whitespace doesn't bust the cache.
 */
export function cacheTextHash(text: string): string {
  return `h${djb2Hash(normalizeWhitespace(text))}`;
}
