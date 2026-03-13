/**
 * Content hiding / unhiding.
 * Hides a content element and inserts a Shadow DOM-isolated placeholder
 * with an undo button. Works for both Twitter posts and generic page blocks.
 */

import { findContentElement } from "./domUtils";

const SHADOW_HOST_ATTR = "data-vigil-placeholder-host";

function isDarkPage(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor;
  if (bg === "rgb(0, 0, 0)" || bg === "rgb(21, 32, 43)") return true;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function buildPlaceholderCSS(dark: boolean): string {
  const borderColor = dark ? "rgb(47, 51, 54)" : "rgb(239, 243, 244)";
  const bgColor = dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)";
  const textColor = dark ? "rgb(139, 152, 165)" : "rgb(83, 100, 113)";
  const hoverBg = dark ? "rgba(255,255,255,0.08)" : "rgba(83,100,113,0.1)";

  return `
    :host { display: block; }
    .placeholder {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid ${borderColor};
      background: ${bgColor}; color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 20px;
    }
    .label { display: flex; align-items: center; gap: 8px; }
    .undo {
      background: none; border: 1px solid ${textColor}; border-radius: 9999px;
      padding: 4px 14px; color: ${textColor}; font-size: 13px; font-weight: 600;
      cursor: pointer; white-space: nowrap;
    }
    .undo:hover { background: ${hoverBg}; }
  `;
}

export function hideContent(contentId: string, _text: string): boolean {
  const el = findContentElement(contentId);
  if (!el) return false;
  if (el.dataset.vigilHidden === "true") return true;

  el.dataset.vigilHidden = "true";
  el.dataset.vigilOriginalDisplay = el.style.display || "";
  el.style.display = "none";

  const dark = isDarkPage();

  const host = document.createElement("div");
  host.setAttribute(SHADOW_HOST_ATTR, contentId);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = buildPlaceholderCSS(dark);

  const wrapper = document.createElement("div");
  wrapper.className = "placeholder";

  const label = document.createElement("span");
  label.className = "label";
  label.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">` +
    `<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>` +
    `Content hidden by Vigil — contains bias triggers`;

  const undoBtn = document.createElement("button");
  undoBtn.className = "undo";
  undoBtn.textContent = "Undo";
  undoBtn.addEventListener("click", () => {
    unhideContent(contentId);
    try { chrome.runtime.sendMessage({ type: "CONTENT_UNHIDDEN", contentId }); } catch { /* */ }
  });

  wrapper.appendChild(label);
  wrapper.appendChild(undoBtn);
  shadow.appendChild(style);
  shadow.appendChild(wrapper);

  el.parentElement?.insertBefore(host, el);
  return true;
}

export function unhideContent(contentId: string): boolean {
  const host = document.querySelector(`[${SHADOW_HOST_ATTR}="${contentId}"]`);
  host?.remove();

  const el = findContentElement(contentId);
  if (!el) return false;

  el.style.display = el.dataset.vigilOriginalDisplay || "";
  delete el.dataset.vigilHidden;
  delete el.dataset.vigilOriginalDisplay;
  return true;
}

/**
 * Obscure content with a blur + fade while analysis is pending.
 * Lightweight alternative to full hiding — lets the user see
 * something is there without exposing the actual text.
 */
export function obscureContent(contentId: string): boolean {
  const el = findContentElement(contentId);
  if (!el) return false;
  if (el.dataset.vigilObscured === "true") return true;

  el.dataset.vigilObscured = "true";
  el.style.filter = "blur(5px)";
  el.style.opacity = "0.4";
  el.style.transition = "filter 0.2s, opacity 0.2s";
  el.style.pointerEvents = "none";
  el.style.userSelect = "none";
  return true;
}

/** Remove the pending-analysis blur. */
export function revealContent(contentId: string): boolean {
  const el = findContentElement(contentId);
  if (!el) return false;
  if (el.dataset.vigilObscured !== "true") return true;

  delete el.dataset.vigilObscured;
  el.style.filter = "";
  el.style.opacity = "";
  el.style.transition = "";
  el.style.pointerEvents = "";
  el.style.userSelect = "";
  return true;
}
