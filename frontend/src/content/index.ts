import { sendRuntimeMessage, type ApplyReformulationPayload } from "../shared/messages";
import type { TweetExtractionItem } from "../shared/platform";
import type { ContentAnalysisResult } from "../shared/content";
import { highlightTweetFindings, highlightContentFindings, clearAllHighlights } from "./highlighter";
import { extractTweetsFromPage, isSupportedTweetPage } from "./tweetExtraction";
import { extractGenericContent, isGenericPage, findGenericElement } from "./genericExtraction";
import { ViewportTracker } from "./viewportTracker";
import { applyReformulation, restoreOriginal, addVerifiedBadge, addAnalyzedBadge } from "./reformulator";
import { hideContent, unhideContent, obscureContent, revealContent } from "./contentHider";
import { findTweetArticle } from "./domUtils";
import type { ReformulationSegment } from "./tweetParser";

const viewportTracker = new ViewportTracker((update) => {
  try {
    chrome.runtime.sendMessage({
      type: "VISIBLE_CONTENT_CHANGED",
      payload: update,
    });
  } catch {
    // Sidepanel may not be open; silently ignore.
  }
});

viewportTracker.start();

// ── Content script message router ──

type ContentHandler = (
  payload: unknown,
  sendResponse: (response: unknown) => void,
) => void;

const handlers: Record<string, ContentHandler> = {
  CONTENT_PING(_payload, sendResponse) {
    sendResponse({ type: "CONTENT_PONG", payload: { ready: true } });
  },

  REQUEST_VISIBLE_CONTENT(_payload, sendResponse) {
    viewportTracker.forceEmit();
    sendResponse({ type: "ACK", payload: { ok: true } });
  },

  EXTRACT_TWEETS_FROM_PAGE(_payload, sendResponse) {
    if (!isSupportedTweetPage()) {
      sendResponse({
        type: "EXTRACTION_ERROR",
        payload: {
          code: "UNSUPPORTED_PAGE",
          message: "Tweet extraction is currently available only on supported tweet-feed pages.",
        },
      });
      return;
    }
    try {
      const result = extractTweetsFromPage();
      sendResponse({ type: "EXTRACT_TWEETS_RESULT", payload: result });
    } catch (error) {
      console.error("[Vigil v2] Tweet extraction failed", error);
      sendResponse({
        type: "EXTRACTION_ERROR",
        payload: { code: "EXTRACTION_FAILED", message: "Failed to extract tweets from current page." },
      });
    }
  },

  EXTRACT_CONTENT_FROM_PAGE(_payload, sendResponse) {
    try {
      if (isSupportedTweetPage()) {
        const tweetResult = extractTweetsFromPage();
        sendResponse({
          type: "EXTRACT_CONTENT_RESULT",
          payload: {
            items: tweetResult.items.map((t: TweetExtractionItem) => ({
              id: t.tweetId,
              text: t.text,
              platform: "twitter" as const,
              pageUrl: window.location.href,
              author: t.authorHandle,
              sourceUrl: t.url,
            })),
            platform: "twitter" as const,
            pageUrl: window.location.href,
            elapsedMs: tweetResult.elapsedMs,
          },
        });
      } else if (isGenericPage()) {
        const result = extractGenericContent();
        sendResponse({ type: "EXTRACT_CONTENT_RESULT", payload: result });
      } else {
        sendResponse({
          type: "EXTRACTION_ERROR",
          payload: { code: "UNSUPPORTED_PAGE", message: "Unable to extract content from this page." },
        });
      }
    } catch (error) {
      console.error("[Vigil v2] Content extraction failed", error);
      sendResponse({
        type: "EXTRACTION_ERROR",
        payload: { code: "EXTRACTION_FAILED", message: "Failed to extract content from current page." },
      });
    }
  },

  HIGHLIGHT_FINDINGS(payload, sendResponse) {
    try {
      const { results } = payload as { results: ContentAnalysisResult[] };
      if (isSupportedTweetPage()) {
        const tweetResults = results.map((r) => ({
          tweetId: r.id, text: r.text, findings: r.findings, tips: r.tips, elapsedMs: r.elapsedMs,
        }));
        const result = highlightTweetFindings(tweetResults);
        sendResponse({ type: "HIGHLIGHT_RESULT", payload: result });
      } else {
        const result = highlightContentFindings(results);
        sendResponse({ type: "HIGHLIGHT_RESULT", payload: result });
      }
    } catch (error) {
      console.error("[Vigil v2] Highlight failed", error);
      sendResponse({ type: "HIGHLIGHT_RESULT", payload: { highlightedItems: 0, totalHighlights: 0 } });
    }
  },

  CLEAR_HIGHLIGHTS(_payload, sendResponse) {
    clearAllHighlights();
    sendResponse({ type: "HIGHLIGHTS_CLEARED", payload: { ok: true } });
  },

  SCROLL_TO_CONTENT(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const scrolled = scrollToContent(contentId);
      sendResponse({ type: "ACK", payload: { ok: scrolled } });
    } catch {
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  APPLY_REFORMULATION(payload, sendResponse) {
    try {
      const p = payload as ApplyReformulationPayload;
      const segments = p.segments as ReformulationSegment[] | undefined;
      const ok = applyReformulation(p.contentId, p.reformulatedText, segments, p.changedIndices);
      sendResponse({ type: "REFORMULATION_APPLIED", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Apply reformulation failed", error);
      sendResponse({ type: "REFORMULATION_APPLIED", payload: { ok: false } });
    }
  },

  RESTORE_ORIGINAL(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const ok = restoreOriginal(contentId);
      sendResponse({ type: "REFORMULATION_APPLIED", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Restore original failed", error);
      sendResponse({ type: "REFORMULATION_APPLIED", payload: { ok: false } });
    }
  },

  HIDE_CONTENT(payload, sendResponse) {
    try {
      const { contentId, text } = payload as { contentId: string; text: string };
      const ok = hideContent(contentId, text);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Hide content failed", error);
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  UNHIDE_CONTENT(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const ok = unhideContent(contentId);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Unhide content failed", error);
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  OBSCURE_CONTENT(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const ok = obscureContent(contentId);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  REVEAL_CONTENT(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const ok = revealContent(contentId);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  MARK_VERIFIED(payload, sendResponse) {
    try {
      const { contentId } = payload as { contentId: string };
      const ok = addVerifiedBadge(contentId);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Mark verified failed", error);
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },

  MARK_ANALYZED(payload, sendResponse) {
    try {
      const { contentId, count } = payload as { contentId: string; count: number };
      const ok = addAnalyzedBadge(contentId, count);
      sendResponse({ type: "ACK", payload: { ok } });
    } catch (error) {
      console.error("[Vigil v2] Mark analyzed failed", error);
      sendResponse({ type: "ACK", payload: { ok: false } });
    }
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  const messageType = (message as { type?: string }).type;
  if (!messageType) return;

  const handler = handlers[messageType];
  if (handler) {
    handler((message as { payload?: unknown }).payload, sendResponse);
    return;
  }
});

function scrollToContent(contentId: string): boolean {
  if (isSupportedTweetPage()) {
    const article = findTweetArticle(contentId);
    if (article) {
      article.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
  } else {
    const el = findGenericElement(contentId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
  }
  return false;
}

async function announceReady(): Promise<void> {
  try {
    await sendRuntimeMessage({
      type: "CONTENT_READY",
      payload: {
        tabId: null,
        url: window.location.href,
      },
    });
  } catch (error) {
    console.debug("[Vigil v2] CONTENT_READY send failed", error);
  }
}

void announceReady();
