import {
  broadcastRuntimeEvent,
  isRuntimeRequestMessage,
  sendTabMessage,
  type RuntimeResponseMap,
} from "../shared/messages";
import type {
  OffscreenRequestMessage,
  OffscreenResponseMessage,
} from "../offscreen/messages";

const OFFSCREEN_DOCUMENT_PATH = "src/offscreen/offscreen.html";

let offscreenCreateInFlight: Promise<void> | null = null;

chrome.runtime.onInstalled.addListener(() => {
  console.info("[Vigil v2] Scaffold installed.");
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ── Helpers ──

async function getActiveTabInfo(): Promise<{
  tabId: number | null;
  url: string | null;
}> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return {
    tabId: activeTab?.id ?? null,
    url: activeTab?.url ?? null,
  };
}

async function hasOffscreenDocument(): Promise<boolean> {
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (
      filter: unknown,
    ) => Promise<Array<{ contextType?: string; documentUrl?: string }>>;
    ContextType?: { OFFSCREEN_DOCUMENT?: string };
  };

  if (
    typeof runtimeWithContexts.getContexts === "function" &&
    runtimeWithContexts.ContextType?.OFFSCREEN_DOCUMENT
  ) {
    try {
      const contexts = await runtimeWithContexts.getContexts({
        contextTypes: [runtimeWithContexts.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
      });
      return contexts.length > 0;
    } catch {
      // Continue to createDocument fallback.
    }
  }

  return false;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreateInFlight) {
    await offscreenCreateInFlight;
    return;
  }

  offscreenCreateInFlight = (async () => {
    if (await hasOffscreenDocument()) return;

    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Run WebLLM in an offscreen document with WebGPU access.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "offscreen create failed";
      if (!message.includes("Only a single offscreen")) throw error;
    }
  })();

  try {
    await offscreenCreateInFlight;
  } finally {
    offscreenCreateInFlight = null;
  }
}

async function sendOffscreenMessage(
  message: OffscreenRequestMessage,
): Promise<OffscreenResponseMessage> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage(message) as Promise<OffscreenResponseMessage>;
}

// ── Tab relay helper ──

/**
 * Creates a handler that relays a message to the active tab's content script.
 * Covers the common pattern: get active tab → forward message → return response.
 */
function tabRelay<TTabType extends string>(
  tabMessageType: TTabType,
  fallbackResponse: unknown,
  payloadMapper?: (request: unknown) => unknown,
): MessageHandler {
  return async (request, _sender, sendResponse) => {
    const activeTab = await getActiveTabInfo();
    if (activeTab.tabId === null) {
      sendResponse(fallbackResponse);
      return;
    }
    try {
      const tabPayload = payloadMapper
        ? payloadMapper(request)
        : (request as { payload?: unknown }).payload;
      const tabMessage = tabPayload !== undefined
        ? { type: tabMessageType, payload: tabPayload }
        : { type: tabMessageType };
      const result = await sendTabMessage(activeTab.tabId, tabMessage as never);
      sendResponse(result);
    } catch (error) {
      console.error(`[Vigil v2] Failed to relay ${tabMessageType}`, error);
      sendResponse(fallbackResponse);
    }
  };
}

// ── Message handler registry ──

type MessageHandler = (
  request: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => void | Promise<void>;

const HIGHLIGHT_FALLBACK = { type: "HIGHLIGHT_RESULT", payload: { highlightedItems: 0, totalHighlights: 0 } };
const ACK_FAIL = { type: "ACK", payload: { ok: false } };
const REFORM_FAIL = { type: "REFORMULATION_APPLIED", payload: { ok: false } };

const messageHandlers: Record<string, MessageHandler> = {
  PING(_request, _sender, sendResponse) {
    const response: RuntimeResponseMap["PING"] = {
      type: "PONG",
      payload: { service: "background", timestamp: Date.now() },
    };
    sendResponse(response);
  },

  async GET_ACTIVE_TAB(_request, _sender, sendResponse) {
    const activeTab = await getActiveTabInfo();
    const response: RuntimeResponseMap["GET_ACTIVE_TAB"] = {
      type: "ACTIVE_TAB",
      payload: activeTab,
    };
    sendResponse(response);
  },

  CONTENT_READY(request, sender, sendResponse) {
    const payload = (request as { payload: { tabId: number | null; url: string } }).payload;
    const tabId = sender.tab?.id ?? payload.tabId;
    console.info("[Vigil v2] Content ready", { tabId, url: payload.url });
    sendResponse({ type: "ACK", payload: { ok: true } });
  },

  EXTRACT_TWEETS_REQUEST: tabRelay(
    "EXTRACT_TWEETS_FROM_PAGE",
    { type: "EXTRACTION_ERROR", payload: { code: "NO_ACTIVE_TAB", message: "No active tab available for extraction." } },
  ),

  EXTRACT_CONTENT_REQUEST: tabRelay(
    "EXTRACT_CONTENT_FROM_PAGE",
    { type: "EXTRACTION_ERROR", payload: { code: "NO_ACTIVE_TAB", message: "No active tab available for extraction." } },
  ),

  HIGHLIGHT_FINDINGS_REQUEST: tabRelay("HIGHLIGHT_FINDINGS", HIGHLIGHT_FALLBACK, (r) => (r as { payload: unknown }).payload),
  CLEAR_HIGHLIGHTS_REQUEST: tabRelay("CLEAR_HIGHLIGHTS", { type: "HIGHLIGHTS_CLEARED", payload: { ok: true } }),
  SCROLL_TO_CONTENT_REQUEST: tabRelay("SCROLL_TO_CONTENT", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  APPLY_REFORMULATION_REQUEST: tabRelay("APPLY_REFORMULATION", REFORM_FAIL, (r) => (r as { payload: unknown }).payload),
  RESTORE_ORIGINAL_REQUEST: tabRelay("RESTORE_ORIGINAL", REFORM_FAIL, (r) => (r as { payload: unknown }).payload),
  OBSCURE_CONTENT_REQUEST: tabRelay("OBSCURE_CONTENT", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  REVEAL_CONTENT_REQUEST: tabRelay("REVEAL_CONTENT", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  HIDE_CONTENT_REQUEST: tabRelay("HIDE_CONTENT", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  UNHIDE_CONTENT_REQUEST: tabRelay("UNHIDE_CONTENT", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  MARK_VERIFIED_REQUEST: tabRelay("MARK_VERIFIED", ACK_FAIL, (r) => (r as { payload: unknown }).payload),
  MARK_ANALYZED_REQUEST: tabRelay("MARK_ANALYZED", ACK_FAIL, (r) => (r as { payload: unknown }).payload),

  async PROXY_FETCH(request, _sender, sendResponse) {
    try {
      const { url, method, headers, body } = (request as { payload: { url: string; method: string; headers: Record<string, string>; body?: string } }).payload;
      const resp = await fetch(url, { method, headers, body: body ?? undefined });
      const respBody = await resp.text();
      sendResponse({
        type: "PROXY_FETCH_RESULT",
        payload: { ok: resp.ok, status: resp.status, statusText: resp.statusText, body: respBody },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error";
      sendResponse({
        type: "PROXY_FETCH_RESULT",
        payload: { ok: false, status: 0, statusText: message, body: "" },
      });
    }
  },

  async WEBLLM_INIT(request, _sender, sendResponse) {
    try {
      const { modelId } = (request as { payload: { modelId: string } }).payload;
      const result = await sendOffscreenMessage({ type: "OFFSCREEN_WEBLLM_INIT", payload: { modelId } });
      sendResponse({
        type: "WEBLLM_ACK",
        payload: result.ok ? { ok: true } : { ok: false, error: result.error },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebLLM init failed.";
      sendResponse({ type: "WEBLLM_ACK", payload: { ok: false, error: message } });
    }
  },

  async WEBLLM_GENERATE(request, _sender, sendResponse) {
    try {
      const payload = (request as { payload: { systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number } }).payload;
      const result = await sendOffscreenMessage({
        type: "OFFSCREEN_WEBLLM_GENERATE",
        payload: {
          systemPrompt: payload.systemPrompt,
          userPrompt: payload.userPrompt,
          temperature: payload.temperature ?? 0.2,
          maxTokens: payload.maxTokens ?? 1024,
        },
      });

      if (!result.ok) {
        sendResponse({ type: "WEBLLM_GENERATE_RESULT", payload: { ok: false, result: "", error: result.error } });
        return;
      }
      sendResponse({
        type: "WEBLLM_GENERATE_RESULT",
        payload: { ok: true, result: "result" in result ? result.result ?? "" : "" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebLLM generation failed.";
      sendResponse({ type: "WEBLLM_GENERATE_RESULT", payload: { ok: false, result: "", error: message } });
    }
  },

  async WEBLLM_UNLOAD(_request, _sender, sendResponse) {
    try {
      const result = await sendOffscreenMessage({ type: "OFFSCREEN_WEBLLM_UNLOAD" });
      sendResponse({
        type: "WEBLLM_ACK",
        payload: result.ok ? { ok: true } : { ok: false, error: result.error },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebLLM unload failed.";
      sendResponse({ type: "WEBLLM_ACK", payload: { ok: false, error: message } });
    }
  },
};

// ── Main message listener ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  // Forward VISIBLE_CONTENT_CHANGED from content script as a runtime event
  if ((message as { type?: string }).type === "VISIBLE_CONTENT_CHANGED") {
    try { void broadcastRuntimeEvent(message); } catch { /* Sidepanel may not be open. */ }
    return;
  }

  if (!isRuntimeRequestMessage(message)) return;

  const type = (message as { type: string }).type;
  const handler = messageHandlers[type];
  if (!handler) return;

  // PING and CONTENT_READY are synchronous; everything else is async
  const result = handler(message, sender, sendResponse);
  if (result instanceof Promise) {
    void result;
    return true;
  }
  if (type !== "PING" && type !== "CONTENT_READY") {
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;

  void broadcastRuntimeEvent({
    type: "TAB_NAVIGATED",
    payload: { tabId, url: changeInfo.url },
  });
});
