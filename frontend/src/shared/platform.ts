/**
 * Tweet extraction types used by the extraction pipeline and message protocol.
 * The rest of the codebase uses ContentItem / ContentAnalysisResult from content.ts.
 */

export interface TweetExtractionItem {
  tweetId: string;
  text: string;
  url?: string;
  authorHandle?: string;
}

export interface ExtractionResult {
  items: TweetExtractionItem[];
  source: "tweet";
  elapsedMs: number;
}

export type ExtractionErrorCode =
  | "NO_ACTIVE_TAB"
  | "UNSUPPORTED_PAGE"
  | "CONTENT_UNAVAILABLE"
  | "EXTRACTION_FAILED";

export interface ExtractionErrorPayload {
  code: ExtractionErrorCode;
  message: string;
}

export interface HighlightResult {
  highlightedItems: number;
  totalHighlights: number;
}
