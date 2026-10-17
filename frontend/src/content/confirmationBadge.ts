import type { Finding } from "../shared/findings";
import { CONFIRMATION_BADGE_MEANING } from "../shared/confirmation";

interface Badge {
  host: HTMLElement;
  article: HTMLElement;
  postId: string;
  text: string;
  originalPosition: string | null;
  hide(): void;
}
const badges = new Map<HTMLElement, Badge>();
let observer: MutationObserver | undefined;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
function currentPostId(article: Element): string | undefined {
  return article.querySelector<HTMLAnchorElement>('a[href*="/status/"]:has(time)')?.pathname.match(/\/status\/(\d+)/)?.[1];
}
function remove(badge: Badge): void {
  badge.host.remove();
  if (badge.originalPosition !== null && badge.article.style.position === "relative")
    badge.article.style.position = badge.originalPosition;
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
  const renderedText = article.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
  if (normalize(renderedText) !== normalize(text)) return false;
  const old = badges.get(article); if (old) remove(old);
  const host = document.createElement("span");
  host.setAttribute("data-vigil-confirmation-badge", "");
  host.style.cssText = "position:absolute;top:10px;right:44px;z-index:5;line-height:normal;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { font: 13px/1.4 system-ui, sans-serif; }
    button { font: 700 12px/1.4 system-ui, sans-serif; color: #422006; background: #fde68a;
      border: 1px solid #a16207; border-radius: 6px; padding: 3px 6px; cursor: help; }
    button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
    [role="tooltip"] { position: fixed; box-sizing: border-box; width: 310px; max-width: calc(100vw - 16px);
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
  tooltip.id = "cb-explanation"; tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
  const meaning = document.createElement("strong"); meaning.textContent = CONFIRMATION_BADGE_MEANING;
  const explanation = document.createElement("p"); explanation.textContent = findings[0].explanation;
  tooltip.append(meaning, explanation); root.append(style, button, tooltip);
  let pinned = false;
  const hide = () => { pinned = false; tooltip.hidden = true; button.setAttribute("aria-expanded", "false"); };
  const show = () => {
    tooltip.hidden = false; button.setAttribute("aria-expanded", "true");
    const rect = button.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.right - tooltip.offsetWidth, innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - tooltip.offsetHeight - 8))}px`;
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
  const originalPosition = getComputedStyle(article).position === "static" || !getComputedStyle(article).position ? article.style.position : null;
  if (originalPosition !== null) article.style.position = "relative";
  article.append(host);
  badges.set(article, { host, article, postId, text: normalize(text), originalPosition, hide });
  watch();
  return true;
}
export function clearConfirmationBadges(): void {
  stopWatching();
  for (const badge of badges.values()) remove(badge);
}
