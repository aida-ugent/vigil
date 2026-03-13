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
  | { type: "OFFSCREEN_WEBLLM_UNLOAD" };

export type OffscreenResponseMessage =
  | { ok: true }
  | { ok: true; result: string }
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

  if (message.type === "OFFSCREEN_WEBLLM_INIT") {
    const payload = (
      message as { payload?: { modelId?: unknown } }
    ).payload;
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
