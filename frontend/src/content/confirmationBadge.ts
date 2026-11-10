import type { Finding } from "../shared/findings";
import { CONFIRMATION_BADGE_MEANING } from "../shared/confirmation";

interface Badge {
  host: HTMLElement;
  article: HTMLElement;
  postId: string;
  text: string;
  hide(): void;
}
const badges = new Map<HTMLElement, Badge>();
let observer: MutationObserver | undefined;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
function currentPostId(article: Element): string | undefined {
  return article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)')?.pathname.match(/\/status\/(\d+)/)?.[1];
}
/** Keep the badge inside the controls row, immediately before the More icon. */
function placeBadge(host: HTMLElement, article: HTMLElement): void {
  const text = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const name = article.querySelector('[data-testid="User-Name"]');
  const actions = [...article.querySelectorAll<HTMLElement>(
    '[data-testid="caret"], [data-testid$="-follow"], [data-testid$="-unfollow"], [aria-label*="Grok"], [aria-label*="grok"]',
  )].filter((action) => action.closest('article') === article);
  let anchor: Element | undefined;
  if (name) {
    // Find the smallest shared header row. Never treat the whole post body as
    // a header, or mistake quoted-post actions for this post's controls.
    for (let row = name.parentElement; row && row !== article; row = row.parentElement) {
      if (text && row.contains(text)) break;
      anchor = [...row.children].find((child) =>
        child !== host && !child.contains(name) && actions.some((action) => child.contains(action)),
      );
      if (anchor) {
        // In X's header the outer row uses space-between. Inserting beside
        // its action container leaves CB floating in that gap. The More
        // button has its own horizontal icon row inside the action container.
        const more = actions.find((action) =>
          action.dataset.testid === "caret" && row!.contains(action),
        );
        if (more) anchor = more;
        break;
      }
    }
  }
  const target = anchor ?? text;
  if (!target) return;
  host.style.alignSelf = anchor ? "center" : "flex-start";
  host.style.margin = anchor ? "0 6px" : "4px 0";
  if (host.nextElementSibling !== target) target.before(host);
}
function remove(badge: Badge): void {
  badge.hide();
  badge.host.remove();
  badges.delete(badge.article);
}
function hideAll(): void { for (const badge of badges.values()) badge.hide(); }
function onOutsidePointer(event: Event): void {
  for (const badge of badges.values()) if (!event.composedPath().includes(badge.host)) badge.hide();
}
function stopWatching(): void {
  observer?.disconnect(); observer = undefined;
  window.removeEventListener("scroll", hideAll, true);
  window.removeEventListener("resize", hideAll);
  document.removeEventListener("pointerdown", onOutsidePointer, true);
}
function watch(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    for (const badge of badges.values()) {
      const text = badge.article.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
      if (!badge.host.isConnected || currentPostId(badge.article) !== badge.postId || normalize(text) !== badge.text) remove(badge);
      else placeBadge(badge.host, badge.article);
    }
    if (!badges.size) stopWatching();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] });
  window.addEventListener("scroll", hideAll, true);
  window.addEventListener("resize", hideAll);
  document.addEventListener("pointerdown", onOutsidePointer, true);
}

/** A post-level warning, separate from ordinary rhetorical span highlights. */
export function addConfirmationBadge(article: HTMLElement, postId: string, text: string, findings: Finding[]): boolean {
  if (!findings.length || currentPostId(article) !== postId) return false;
  const textElement = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
  if (!textElement || normalize(textElement.textContent ?? "") !== normalize(text)) return false;
  const old = badges.get(article); if (old) remove(old);
  const host = document.createElement("span");
  host.setAttribute("data-vigil-confirmation-badge", "");
  // Participate in layout so the badge cannot cover native header controls.
  host.style.cssText = "display:block;position:relative;align-self:flex-start;flex:none;width:max-content;max-width:100%;margin:4px 0;line-height:normal;";
  // Keep personalized text out of the page's ordinary DOM traversal. Retain
  // the root only in this content-script closure; never expose it on the host.
  // This reduces DOM disclosure, but does not isolate UI from the host page.
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { font: 13px/1.4 system-ui, sans-serif; }
    button { font: 700 12px/1.4 system-ui, sans-serif; color: #422006; background: #fde68a;
      border: 1px solid #a16207; border-radius: 6px; padding: 3px 6px; cursor: help; }
    button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
    [role="tooltip"] { position: fixed; inset: auto; margin: 0; box-sizing: border-box; width: 310px; max-width: calc(100vw - 16px);
      z-index: 2147483647; color: #f8fafc; background: #172033; border: 1px solid #94a3b8;
      border-radius: 8px; padding: 12px; box-shadow: 0 4px 18px #0005; overflow-wrap: anywhere;
      max-height: calc(100vh - 16px); overflow: auto; font: 13px/1.45 system-ui, sans-serif; }
    [hidden] { display: none !important; }
    p { margin: 8px 0 0; }
  `;
  const button = document.createElement("button");
  button.type = "button"; button.textContent = "CB?";
  button.setAttribute("aria-label", "CB? Possible confirmation-bias risk");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-describedby", "cb-explanation");
  const tooltip = document.createElement("div");
  // The top layer keeps viewport coordinates independent of transformed feed rows.
  tooltip.setAttribute("popover", "manual");
  tooltip.id = "cb-explanation"; tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  const meaning = document.createElement("strong"); meaning.textContent = CONFIRMATION_BADGE_MEANING;
  const explanationText = findings[0].explanation;
  const explanation = document.createElement("p");
  tooltip.append(meaning, explanation); root.append(style, button, tooltip);
  let pinned = false;
  const hide = () => {
    pinned = false;
    tooltip.hidePopover?.();
    tooltip.hidden = true;
    explanation.textContent = "";
    button.setAttribute("aria-expanded", "false");
  };
  const show = (event?: Event) => {
    explanation.textContent = explanationText;
    tooltip.hidden = false;
    tooltip.showPopover?.();
    button.setAttribute("aria-expanded", "true");
    const rect = button.getBoundingClientRect();
    const pointer = event && "clientX" in event ? event as MouseEvent : undefined;
    const x = pointer ? pointer.clientX : rect.left;
    const y = pointer ? pointer.clientY : rect.bottom;
    const gap = 8;
    const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    const top = y + gap + height > innerHeight - gap
      ? (pointer ? pointer.clientY : rect.top) - height - gap
      : y + gap;
    tooltip.style.left = `${Math.max(gap, Math.min(x, innerWidth - width - gap))}px`;
    tooltip.style.top = `${Math.max(gap, Math.min(top, innerHeight - height - gap))}px`;
  };
  host.addEventListener("pointerenter", show);
  host.addEventListener("pointerleave", () => { if (!pinned && root.activeElement !== button) hide(); });
  button.addEventListener("focus", show);
  button.addEventListener("blur", () => { if (!pinned) hide(); });
  // Stop the post's click handler from navigating when the badge is used.
  host.addEventListener("click", event => event.stopPropagation());
  button.addEventListener("pointerdown", event => event.stopPropagation());
  button.addEventListener("click", event => { event.stopPropagation(); pinned = !pinned; if (pinned) show(); else hide(); });
  button.addEventListener("keydown", event => { event.stopPropagation(); if (event.key === "Escape") hide(); });
  placeBadge(host, article);
  badges.set(article, { host, article, postId, text: normalize(text), hide });
  watch();
  return true;
}
export function clearConfirmationBadges(): void {
  stopWatching();
  for (const badge of badges.values()) remove(badge);
}
