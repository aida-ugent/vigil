import type { Finding } from "./findings";

export type ContentPlatform = "twitter" | "generic";

/**
 * Universal content unit. Subsumes the tweet-specific TweetExtractionItem
 * so the same pipeline handles tweets, news paragraphs, and blog sections.
 */
export interface ContentItem {
  id: string;
  text: string;
  platform: ContentPlatform;
  pageUrl: string;
  author?: string;
  sourceUrl?: string;
}

export interface ContentExtractionResult {
  items: ContentItem[];
  platform: ContentPlatform;
  pageUrl: string;
  elapsedMs: number;
}

export interface ContentAnalysisResult {
  id: string;
  text: string;
  findings: Finding[];
  tips: string[];
  elapsedMs: number;
  cached: boolean;
}

/**
 * Broadcast from content script → sidepanel whenever the user scrolls
 * and the set of visible content items changes.
 */
export interface VisibleContentUpdate {
  visibleIds: string[];
  primaryId: string | null;
  primaryText: string | null;
  primaryAuthor: string | null;
  pageTitle: string | null;
  platform: ContentPlatform;
  pageUrl: string;
}

export interface CacheEntry {
  id: string;
  text: string;
  textHash: string;
  pageUrl: string;
  platform: ContentPlatform;
  findings: Finding[];
  tips: string[];
  pluginIds: string[];
  analyzerMode: string;
  sensitivity: number;
  analyzedAt: number;
}

export interface CacheStats {
  totalEntries: number;
  entriesForPage: number;
  oldestTimestamp: number | null;
}
