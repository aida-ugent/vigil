import { z } from "zod";
import type {
  ExtractionErrorPayload,
  ExtractionResult,
  HighlightResult,
} from "./platform";
import type {
  ContentAnalysisResult,
  ContentExtractionResult,
  VisibleContentUpdate,
} from "./content";

/**
 * Runtime requests sent via chrome.runtime.sendMessage.
 */
export interface ProxyFetchPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

export type RuntimeRequestMessage =
  | { type: "PING" }
  | { type: "GET_ACTIVE_TAB" }
  | { type: "CONTENT_READY"; payload: { tabId: number | null; url: string } }
  | { type: "EXTRACT_TWEETS_REQUEST" }
  | { type: "EXTRACT_CONTENT_REQUEST" }
  | { type: "HIGHLIGHT_FINDINGS_REQUEST"; payload: { results: ContentAnalysisResult[] } }
  | { type: "CLEAR_HIGHLIGHTS_REQUEST" }
  | { type: "SCROLL_TO_CONTENT_REQUEST"; payload: { contentId: string } }
  | { type: "APPLY_REFORMULATION_REQUEST"; payload: ApplyReformulationPayload }
  | { type: "RESTORE_ORIGINAL_REQUEST"; payload: { contentId: string } }
  | { type: "OBSCURE_CONTENT_REQUEST"; payload: { contentId: string } }
  | { type: "REVEAL_CONTENT_REQUEST"; payload: { contentId: string } }
  | { type: "HIDE_CONTENT_REQUEST"; payload: { contentId: string; text: string } }
  | { type: "UNHIDE_CONTENT_REQUEST"; payload: { contentId: string } }
  | { type: "MARK_VERIFIED_REQUEST"; payload: { contentId: string } }
  | { type: "MARK_ANALYZED_REQUEST"; payload: { contentId: string; count: number } }
  | { type: "PROXY_FETCH"; payload: ProxyFetchPayload }
  | { type: "WEBLLM_INIT"; payload: { modelId: string } }
  | {
      type: "WEBLLM_GENERATE";
      payload: {
        systemPrompt: string;
        userPrompt: string;
        temperature?: number;
        maxTokens?: number;
      };
    }
  | { type: "WEBLLM_UNLOAD" };

/**
 * Runtime events broadcast from background to listeners (e.g., sidepanel).
 */
export type RuntimeEventMessage =
  | {
      type: "TAB_NAVIGATED";
      payload: { tabId: number; url: string };
    }
  | {
      type: "VISIBLE_CONTENT_CHANGED";
      payload: VisibleContentUpdate;
    }
  | {
      type: "WEBLLM_PROGRESS";
      payload: { progress: number; text: string };
    }
  | {
      type: "WEBLLM_READY";
      payload: { modelId: string };
    }
  | {
      type: "WEBLLM_ERROR";
      payload: { error: string };
    }
  | {
      type: "WEBLLM_RESULT";
      payload: { result: string };
    };

/**
 * Tab-scoped requests sent via chrome.tabs.sendMessage.
 */
export interface ApplyReformulationPayload {
  contentId: string;
  reformulatedText: string;
  segments?: unknown[];
  changedIndices?: number[];
}

export type TabRequestMessage =
  | { type: "CONTENT_PING" }
  | { type: "EXTRACT_TWEETS_FROM_PAGE" }
  | { type: "EXTRACT_CONTENT_FROM_PAGE" }
  | { type: "HIGHLIGHT_FINDINGS"; payload: { results: ContentAnalysisResult[] } }
  | { type: "CLEAR_HIGHLIGHTS" }
  | { type: "SCROLL_TO_CONTENT"; payload: { contentId: string } }
  | { type: "APPLY_REFORMULATION"; payload: ApplyReformulationPayload }
  | { type: "RESTORE_ORIGINAL"; payload: { contentId: string } }
  | { type: "HIDE_CONTENT"; payload: { contentId: string; text: string } }
  | { type: "UNHIDE_CONTENT"; payload: { contentId: string } }
  | { type: "MARK_VERIFIED"; payload: { contentId: string } }
  | { type: "MARK_ANALYZED"; payload: { contentId: string; count: number } };

type AckResponse = { type: "ACK"; payload: { ok: true } };
type HighlightResponse = { type: "HIGHLIGHT_RESULT"; payload: HighlightResult };
type HighlightsClearedResponse = { type: "HIGHLIGHTS_CLEARED"; payload: { ok: true } };
type WebLLMAckResponse = {
  type: "WEBLLM_ACK";
  payload: { ok: boolean; error?: string };
};
type WebLLMGenerateResponse = {
  type: "WEBLLM_GENERATE_RESULT";
  payload: { ok: boolean; result: string; error?: string };
};

export type RuntimeResponseMap = {
  PING: { type: "PONG"; payload: { service: "background"; timestamp: number } };
  GET_ACTIVE_TAB: {
    type: "ACTIVE_TAB";
    payload: { tabId: number | null; url: string | null };
  };
  CONTENT_READY: AckResponse;
  EXTRACT_TWEETS_REQUEST:
    | { type: "EXTRACT_TWEETS_RESULT"; payload: ExtractionResult }
    | { type: "EXTRACTION_ERROR"; payload: ExtractionErrorPayload };
  EXTRACT_CONTENT_REQUEST:
    | { type: "EXTRACT_CONTENT_RESULT"; payload: ContentExtractionResult }
    | { type: "EXTRACTION_ERROR"; payload: ExtractionErrorPayload };
  HIGHLIGHT_FINDINGS_REQUEST: HighlightResponse;
  CLEAR_HIGHLIGHTS_REQUEST: HighlightsClearedResponse;
  SCROLL_TO_CONTENT_REQUEST: AckResponse;
  APPLY_REFORMULATION_REQUEST: ReformulationAppliedResponse;
  RESTORE_ORIGINAL_REQUEST: ReformulationAppliedResponse;
  OBSCURE_CONTENT_REQUEST: AckResponse;
  REVEAL_CONTENT_REQUEST: AckResponse;
  HIDE_CONTENT_REQUEST: AckResponse;
  UNHIDE_CONTENT_REQUEST: AckResponse;
  MARK_VERIFIED_REQUEST: AckResponse;
  MARK_ANALYZED_REQUEST: AckResponse;
  PROXY_FETCH: { type: "PROXY_FETCH_RESULT"; payload: ProxyFetchResult };
  WEBLLM_INIT: WebLLMAckResponse;
  WEBLLM_GENERATE: WebLLMGenerateResponse;
  WEBLLM_UNLOAD: WebLLMAckResponse;
};

type ReformulationAppliedResponse = { type: "REFORMULATION_APPLIED"; payload: { ok: boolean } };

export type TabResponseMap = {
  CONTENT_PING: { type: "CONTENT_PONG"; payload: { ready: true } };
  EXTRACT_TWEETS_FROM_PAGE:
    | { type: "EXTRACT_TWEETS_RESULT"; payload: ExtractionResult }
    | { type: "EXTRACTION_ERROR"; payload: ExtractionErrorPayload };
  EXTRACT_CONTENT_FROM_PAGE:
    | { type: "EXTRACT_CONTENT_RESULT"; payload: ContentExtractionResult }
    | { type: "EXTRACTION_ERROR"; payload: ExtractionErrorPayload };
  HIGHLIGHT_FINDINGS: HighlightResponse;
  CLEAR_HIGHLIGHTS: HighlightsClearedResponse;
  SCROLL_TO_CONTENT: AckResponse;
  APPLY_REFORMULATION: ReformulationAppliedResponse;
  RESTORE_ORIGINAL: ReformulationAppliedResponse;
  HIDE_CONTENT: AckResponse;
  UNHIDE_CONTENT: AckResponse;
  MARK_VERIFIED: AckResponse;
  MARK_ANALYZED: AckResponse;
};

export type RuntimeRequestType = RuntimeRequestMessage["type"];
export type TabRequestType = TabRequestMessage["type"];
export type RuntimeEventType = RuntimeEventMessage["type"];

/**
 * Sends a typed runtime request to another extension context.
 */
export async function sendRuntimeMessage<TType extends RuntimeRequestType>(
  message: Extract<RuntimeRequestMessage, { type: TType }>,
): Promise<RuntimeResponseMap[TType]> {
  return chrome.runtime.sendMessage(message) as Promise<RuntimeResponseMap[TType]>;
}

/**
 * Sends a typed tab-scoped request to a content script.
 */
export async function sendTabMessage<TType extends TabRequestType>(
  tabId: number,
  message: Extract<TabRequestMessage, { type: TType }>,
): Promise<TabResponseMap[TType]> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<TabResponseMap[TType]>;
}

/**
 * Broadcasts a typed runtime event (background -> all extension contexts).
 */
export async function broadcastRuntimeEvent<TType extends RuntimeEventType>(
  event: Extract<RuntimeEventMessage, { type: TType }>,
): Promise<void> {
  await chrome.runtime.sendMessage(event);
}

// ── Zod schemas for runtime validation of incoming messages ──

const payloadWith = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ payload: z.object(shape).passthrough() });

const runtimeRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PING") }),
  z.object({ type: z.literal("GET_ACTIVE_TAB") }),
  z.object({ type: z.literal("EXTRACT_TWEETS_REQUEST") }),
  z.object({ type: z.literal("EXTRACT_CONTENT_REQUEST") }),
  z.object({ type: z.literal("CLEAR_HIGHLIGHTS_REQUEST") }),
  z.object({ type: z.literal("WEBLLM_UNLOAD") }),
  z.object({ type: z.literal("PROXY_FETCH") }).merge(payloadWith({ url: z.string(), method: z.string() })),
  z.object({ type: z.literal("CONTENT_READY") }).merge(payloadWith({ url: z.string() })),
  z.object({ type: z.literal("HIGHLIGHT_FINDINGS_REQUEST") }).merge(payloadWith({ results: z.array(z.any()) })),
  z.object({ type: z.literal("SCROLL_TO_CONTENT_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("APPLY_REFORMULATION_REQUEST") }).merge(payloadWith({ contentId: z.string(), reformulatedText: z.string() })),
  z.object({ type: z.literal("RESTORE_ORIGINAL_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("OBSCURE_CONTENT_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("REVEAL_CONTENT_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("HIDE_CONTENT_REQUEST") }).merge(payloadWith({ contentId: z.string(), text: z.string() })),
  z.object({ type: z.literal("UNHIDE_CONTENT_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("MARK_VERIFIED_REQUEST") }).merge(payloadWith({ contentId: z.string() })),
  z.object({ type: z.literal("MARK_ANALYZED_REQUEST") }).merge(payloadWith({ contentId: z.string(), count: z.number() })),
  z.object({ type: z.literal("WEBLLM_INIT") }).merge(payloadWith({ modelId: z.string() })),
  z.object({ type: z.literal("WEBLLM_GENERATE") }).merge(payloadWith({ systemPrompt: z.string(), userPrompt: z.string() })),
]);

const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TAB_NAVIGATED") }).merge(payloadWith({ tabId: z.number(), url: z.string() })),
  z.object({ type: z.literal("VISIBLE_CONTENT_CHANGED") }).merge(payloadWith({ visibleIds: z.array(z.any()), platform: z.string() })),
  z.object({ type: z.literal("WEBLLM_PROGRESS") }).merge(payloadWith({ progress: z.number(), text: z.string() })),
  z.object({ type: z.literal("WEBLLM_READY") }).merge(payloadWith({ modelId: z.string() })),
  z.object({ type: z.literal("WEBLLM_ERROR") }).merge(payloadWith({ error: z.string() })),
  z.object({ type: z.literal("WEBLLM_RESULT") }).merge(payloadWith({ result: z.string() })),
]);

/**
 * Type guard for runtime requests sent to the background.
 * Validates shape using Zod discriminated union.
 */
export function isRuntimeRequestMessage(
  value: unknown,
): value is RuntimeRequestMessage {
  return runtimeRequestSchema.safeParse(value).success;
}

/**
 * Type guard for runtime events (background broadcasts + content script events).
 * Validates shape using Zod discriminated union.
 */
export function isRuntimeEventMessage(
  value: unknown,
): value is RuntimeEventMessage {
  return runtimeEventSchema.safeParse(value).success;
}
