import type { ContentItem, ContentPlatform, VisibleContentUpdate } from "../shared/content";
import { genericContentId, tweetFallbackId, normalizeWhitespace } from "../shared/utils";
import { isTweetPage } from "./domUtils";

const DEBOUNCE_MS = 150;
const OBSERVER_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1.0];
const OBSERVER_ROOT_MARGIN = "-10% 0px -10% 0px";
const RECHECK_INTERVAL_MS = 2000;

interface TrackedEntry {
  element: Element;
  item: ContentItem;
  ratio: number;
}

type UpdateCallback = (update: VisibleContentUpdate) => void;

function detectPlatform(): ContentPlatform {
  return isTweetPage() ? "twitter" : "generic";
}

function parseTweetId(article: Element): string | null {
  const anchor = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  if (!anchor) return null;
  const match = anchor.href.match(/\/status\/(\d+)/);
  return match?.[1] ?? null;
}

function getStatusPageTweetId(pathname: string): string | null {
  const match = pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return match?.[1] ?? null;
}

function getTweetAuthor(article: Element): string | undefined {
  const anchor = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  if (!anchor) return undefined;
  const match = anchor.href.match(/\/([^/]+)\/status\//);
  return match?.[1];
}

function getTweetText(article: Element): string {
  const textEl = article.querySelector('[data-testid="tweetText"]');
  return textEl?.textContent ? normalizeWhitespace(textEl.textContent) : "";
}

function buildTweetItem(article: Element): ContentItem | null {
  const text = getTweetText(article);
  if (text.length < 8) return null;

  const tweetId = parseTweetId(article) ?? tweetFallbackId(text);
  return {
    id: tweetId,
    text,
    platform: "twitter",
    pageUrl: window.location.href,
    author: getTweetAuthor(article),
    sourceUrl: article.querySelector<HTMLAnchorElement>('a[href*="/status/"]')?.href,
  };
}

function buildGenericItem(block: Element): ContentItem | null {
  const text = normalizeWhitespace(block.textContent ?? "");
  if (text.length < 40) return null;

  return {
    id: genericContentId(text),
    text,
    platform: "generic",
    pageUrl: window.location.href,
  };
}

/**
 * Tracks which content items are visible in the viewport using IntersectionObserver.
 * Sends debounced VisibleContentUpdate messages as the user scrolls.
 * Works for both Twitter feeds (per-tweet) and generic pages (per-paragraph/section).
 */
export class ViewportTracker {
  private observer: IntersectionObserver | null = null;
  private visibleMap = new Map<string, TrackedEntry>();
  private callback: UpdateCallback;
  private platform: ContentPlatform;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private mutationObserver: MutationObserver | null = null;
  private lastPrimaryId: string | null = null;
  private observedElements = new WeakSet<Element>();

  constructor(callback: UpdateCallback) {
    this.callback = callback;
    this.platform = detectPlatform();
  }

  start(): void {
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersection(entries),
      {
        threshold: OBSERVER_THRESHOLDS,
        rootMargin: OBSERVER_ROOT_MARGIN,
      },
    );

    this.observeExistingElements();
    this.startMutationObserver();
    this.recheckTimer = setInterval(() => this.observeExistingElements(), RECHECK_INTERVAL_MS);

    setTimeout(() => this.emitUpdate(), 500);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.visibleMap.clear();
    this.observedElements = new WeakSet();
  }

  private observeExistingElements(): void {
    if (!this.observer) return;

    const elements = this.platform === "twitter"
      ? Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
      : this.getGenericContentElements();

    for (const el of elements) {
      if (!this.observedElements.has(el)) {
        this.observedElements.add(el);
        this.observer.observe(el);
      }
    }
  }

  private getGenericContentElements(): Element[] {
    const main =
      document.querySelector("article") ??
      document.querySelector('[role="main"]') ??
      document.querySelector("main") ??
      document.body;

    const blocks = main.querySelectorAll(
      "p, h1, h2, h3, h4, blockquote, li, [class*='paragraph'], [class*='body-text']",
    );

    return Array.from(blocks).filter((block) => {
      if (block.closest("nav, footer, header, aside, [role='navigation']")) return false;
      const text = block.textContent?.trim() ?? "";
      return text.length >= 40;
    });
  }

  private startMutationObserver(): void {
    this.mutationObserver = new MutationObserver(() => {
      this.observeExistingElements();
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private handleIntersection(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const item = this.platform === "twitter"
        ? buildTweetItem(entry.target)
        : buildGenericItem(entry.target);

      if (!item) continue;

      if (entry.intersectionRatio > 0) {
        this.visibleMap.set(item.id, {
          element: entry.target,
          item,
          ratio: entry.intersectionRatio,
        });
      } else {
        this.visibleMap.delete(item.id);
      }
    }

    this.scheduleDebouncedUpdate();
  }

  private scheduleDebouncedUpdate(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.emitUpdate(), DEBOUNCE_MS);
  }

  /** Force-emit the current state, bypassing the dedup check.
   *  Used when the sidepanel opens after content is already visible. */
  forceEmit(): void {
    this.lastPrimaryId = null;
    this.emitUpdate();
  }

  private emitUpdate(): void {
    const visibleIds = Array.from(this.visibleMap.keys());
    let primaryEntry: TrackedEntry | null = null;
    const statusPageTweetId =
      this.platform === "twitter" ? getStatusPageTweetId(window.location.pathname) : null;

    // On /status/... pages, prefer the opened tweet whenever it's currently visible.
    // This prevents replies from hijacking the "Currently Viewing" card at load.
    if (statusPageTweetId) {
      primaryEntry = this.visibleMap.get(statusPageTweetId) ?? null;
    }

    if (!primaryEntry) {
      let bestScore = -1;
      for (const tracked of this.visibleMap.values()) {
        const rect = tracked.element.getBoundingClientRect();
        const viewportCenter = window.innerHeight / 2;
        const elementCenter = rect.top + rect.height / 2;
        const distFromCenter = Math.abs(elementCenter - viewportCenter);
        const proximityScore = 1 - distFromCenter / window.innerHeight;
        const score = tracked.ratio * 0.6 + proximityScore * 0.4;

        if (score > bestScore) {
          bestScore = score;
          primaryEntry = tracked;
        }
      }
    }

    const primaryId = primaryEntry?.item.id ?? null;

    if (primaryId === this.lastPrimaryId && visibleIds.length === this.visibleMap.size) {
      return;
    }
    this.lastPrimaryId = primaryId;

    this.callback({
      visibleIds,
      primaryId,
      primaryText: primaryEntry?.item.text ?? null,
      primaryAuthor: primaryEntry?.item.author ?? null,
      pageTitle: document.title || null,
      platform: this.platform,
      pageUrl: window.location.href,
    });
  }
}
