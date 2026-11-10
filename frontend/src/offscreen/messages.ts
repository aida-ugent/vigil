export type OffscreenRequestMessage =
  | { type: "OFFSCREEN_WEBLLM_INIT"; payload: { modelId: string } }
  | {
      type: "OFFSCREEN_WEBLLM_GENERATE";
      payload: {
        systemPrompt: string;
        userPrompt: string;
        temperature: number;
        maxTokens: number;
      };
    }
  | { type: "OFFSCREEN_WEBLLM_UNLOAD" }
  | { type: "OFFSCREEN_EMBED"; payload: { query?: string; drain?: number } };

export type OffscreenResponseMessage =
  | { ok: true }
  | { ok: true; result: string }
  /** Vectors cross chrome.runtime as plain arrays: messaging is JSON, not structured clone. */
  | { ok: true; vector: number[] | null; pending: number }
  | { ok: false; error: string };

export function isOffscreenRequestMessage(
  value: unknown,
): value is OffscreenRequestMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<OffscreenRequestMessage>;
  if (message.type === "OFFSCREEN_WEBLLM_UNLOAD") {
    return true;
  }

  if (message.type === "OFFSCREEN_EMBED") {
    const payload = (
      message as { payload?: { query?: unknown; drain?: unknown } }
    ).payload;
    return (
      !!payload &&
      (payload.query === undefined ||
        (typeof payload.query === "string" && payload.query.length <= 1500)) &&
      (payload.drain === undefined ||
        (typeof payload.drain === "number" &&
          Number.isInteger(payload.drain) &&
          payload.drain >= 1 &&
          payload.drain <= 32))
    );
  }

  if (message.type === "OFFSCREEN_WEBLLM_INIT") {
    const payload = (message as { payload?: { modelId?: unknown } }).payload;
    return !!payload && typeof payload.modelId === "string";
  }

  if (message.type === "OFFSCREEN_WEBLLM_GENERATE") {
    const payload = (
      message as {
        payload?: {
          systemPrompt?: unknown;
          userPrompt?: unknown;
          temperature?: unknown;
          maxTokens?: unknown;
        };
      }
    ).payload;
    return (
      !!payload &&
      typeof payload.systemPrompt === "string" &&
      typeof payload.userPrompt === "string" &&
      typeof payload.temperature === "number" &&
      typeof payload.maxTokens === "number"
    );
  }

  return false;
}
