/**
 * Tweet parser — extracts structured segments from tweet HTML and
 * reconstructs tweet HTML from reformulated segments.
 *
 * Ported from frontend/src/utils/tweetParser.ts. Preserves @mentions,
 * #hashtags, URLs, emojis, and line breaks so the LLM only touches
 * plain-text segments.
 */

export interface ReformulationSegment {
  type: "text" | "mention" | "url" | "hashtag" | "emoji" | "linebreak";
  content: string;
  metadata?: Record<string, string | undefined>;
}

export interface ParsedContent {
  segments: ReformulationSegment[];
  originalText: string;
}

export function parseTweetHTML(container: HTMLElement): ParsedContent {
  const segments: ReformulationSegment[] = [];
  let originalText = "";

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue || "";
      if (text.trim()) {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]) {
            segments.push({ type: "text", content: lines[i] });
            originalText += lines[i];
          }
          if (i < lines.length - 1) {
            segments.push({ type: "linebreak", content: "\n" });
            originalText += "\n";
          }
        }
      } else if (text === "\n") {
        segments.push({ type: "linebreak", content: "\n" });
        originalText += "\n";
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt") || "";
      const src = el.getAttribute("src") || "";
      segments.push({ type: "emoji", content: alt, metadata: { alt, src } });
      originalText += alt;
      return;
    }

    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      const text = el.textContent || "";

      if (href.startsWith("/") && text.startsWith("@")) {
        segments.push({ type: "mention", content: text, metadata: { href } });
      } else if (href.startsWith("/hashtag/") || text.startsWith("#")) {
        segments.push({ type: "hashtag", content: text, metadata: { href } });
      } else {
        segments.push({
          type: "url",
          content: text,
          metadata: { href, display: text },
        });
      }
      originalText += text;
      return;
    }

    node.childNodes.forEach(walk);
  }

  walk(container);
  return { segments, originalText: originalText.trim() };
}

/**
 * Builds a new tweet text container from reformulated segments,
 * reproducing Twitter/X's DOM structure so it renders natively.
 */
export function reconstructTweetHTML(
  segments: ReformulationSegment[],
  originalContainer: HTMLElement,
): HTMLElement {
  const root = document.createElement("div");
  root.className = originalContainer.className;
  root.setAttribute("dir", originalContainer.getAttribute("dir") || "auto");
  root.setAttribute("lang", originalContainer.getAttribute("lang") || "en");
  const testId = originalContainer.getAttribute("data-testid");
  if (testId) root.setAttribute("data-testid", testId);

  let currentSpan: HTMLSpanElement | null = null;
  let textSegIdx = 0;

  function ensureSpan(): HTMLSpanElement {
    if (!currentSpan) {
      currentSpan = document.createElement("span");
      currentSpan.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3";
      root.appendChild(currentSpan);
    }
    return currentSpan;
  }
  function closeSpan(): void {
    currentSpan = null;
  }

  for (const seg of segments) {
    switch (seg.type) {
      case "text": {
        const span = ensureSpan();
        const inner = document.createElement("span");
        inner.setAttribute("data-vigil-seg", String(textSegIdx));
        inner.appendChild(document.createTextNode(seg.content));
        span.appendChild(inner);
        textSegIdx++;
        break;
      }

      case "linebreak":
        ensureSpan().appendChild(document.createTextNode("\n"));
        break;

      case "mention":
      case "hashtag":
      case "url": {
        closeSpan();
        const linkDiv = document.createElement("div");
        linkDiv.className = "css-175oi2r r-xoduu5";
        const linkSpan = document.createElement("span");
        linkSpan.className = "r-18u37iz";
        const link = document.createElement("a");
        link.setAttribute("dir", "ltr");
        link.setAttribute("href", seg.metadata?.href || "#");
        link.setAttribute("role", "link");
        link.className = "css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3 r-1loqt21";
        link.style.color = "rgb(29, 155, 240)";
        link.textContent = seg.content;
        if (seg.type === "url") {
          link.setAttribute("rel", "noopener noreferrer nofollow");
          link.setAttribute("target", "_blank");
        }
        linkSpan.appendChild(link);
        linkDiv.appendChild(linkSpan);
        root.appendChild(linkDiv);
        break;
      }

      case "emoji": {
        const span = ensureSpan();
        const img = document.createElement("img");
        img.setAttribute("alt", seg.metadata?.alt || seg.content);
        img.setAttribute("draggable", "false");
        img.setAttribute("src", seg.metadata?.src || "");
        img.className = "r-4qtqp9 r-dflpy8 r-k4bwe5 r-1kpi4qh r-pp5qcn r-h9hxbl";
        span.appendChild(img);
        break;
      }
    }
  }

  return root;
}

/**
 * Returns the indices of text segments whose content differs between
 * the original and reformulated segment arrays.
 */
export function computeChangedIndices(
  original: ReformulationSegment[],
  reformulated: ReformulationSegment[],
): number[] {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const origText = original.filter((s) => s.type === "text").map((s) => s.content);
  const newText = reformulated.filter((s) => s.type === "text").map((s) => s.content);
  const changed: number[] = [];
  for (let i = 0; i < newText.length; i++) {
    if (i >= origText.length || normalize(newText[i]) !== normalize(origText[i])) {
      changed.push(i);
    }
  }
  return changed;
}
