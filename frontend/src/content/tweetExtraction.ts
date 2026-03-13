import type { ExtractionResult, TweetExtractionItem } from "../shared/platform";
import { normalizeWhitespace, tweetFallbackId } from "../shared/utils";
import { isTweetPage } from "./domUtils";

function parseStatusUrl(href: string): { tweetId: string | null; authorHandle?: string } {
  try {
    const parsed = new URL(href, window.location.origin);
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) {
      return { tweetId: null };
    }

    return { authorHandle: match[1], tweetId: match[2] };
  } catch {
    return { tweetId: null };
  }
}

function extractTweetText(container: Element): string {
  const textBlocks = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="tweetText"]'),
  ).filter((node) => node.closest('article[data-testid="tweet"]') === container);

  const primaryText = textBlocks[0];
  if (primaryText?.textContent) {
    return normalizeWhitespace(primaryText.textContent);
  }

  return "";
}

function isReplyCommentTweet(container: Element): boolean {
  const socialContext = container.querySelector('[data-testid="socialContext"]');
  if (!socialContext?.textContent) {
    return false;
  }

  return /replying to/i.test(socialContext.textContent);
}

export function extractTweetsFromPage(): ExtractionResult {
  const startedAt = performance.now();
  const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const deduped = new Map<string, TweetExtractionItem>();

  for (const tweet of tweets) {
    if (isReplyCommentTweet(tweet)) {
      continue;
    }

    const text = extractTweetText(tweet);
    if (text.length < 8) {
      continue;
    }

    const statusAnchor = tweet.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
    const parsed = statusAnchor ? parseStatusUrl(statusAnchor.href) : { tweetId: null as string | null };
    const tweetId = parsed.tweetId ?? tweetFallbackId(text);

    if (deduped.has(tweetId)) {
      continue;
    }

    deduped.set(tweetId, {
      tweetId,
      text,
      url: statusAnchor?.href,
      authorHandle: parsed.authorHandle,
    });
  }

  return {
    items: Array.from(deduped.values()),
    source: "tweet",
    elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

export function isSupportedTweetPage(): boolean {
  return isTweetPage();
}
