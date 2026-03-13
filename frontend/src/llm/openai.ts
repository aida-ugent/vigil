import { sendRuntimeMessage, type ProxyFetchResult } from "../shared/messages";
import type { LLMBackend } from "../shared/settings";
import type { LLMOptions, LLMService } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Tries to extract a human-readable message from an API error JSON body.
 * Handles OpenAI (`{ error: { message } }`) and Ollama (`{ error }`) formats.
 */
function extractApiErrorMessage(body: string): string | undefined {
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    if (typeof data.error === "object" && data.error !== null) {
      const msg = (data.error as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
    if (typeof data.error === "string") return data.error;
  } catch {
    // Not JSON — fall through
  }
  return undefined;
}

/**
 * Routes the fetch through the background service worker via PROXY_FETCH
 * message. This avoids CORS/origin issues (e.g. Ollama rejects
 * chrome-extension:// origins with 403).
 */
async function proxyFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<ProxyFetchResult> {
  const response = await sendRuntimeMessage({
    type: "PROXY_FETCH",
    payload: { url, method, headers, body },
  });
  return response.payload;
}

/**
 * OpenAI-compatible chat completions client. Works with OpenAI, Anthropic
 * (via proxy), Ollama, and any provider exposing /v1/chat/completions.
 *
 * All HTTP requests are routed through the background service worker to
 * avoid chrome-extension:// Origin header issues with local servers.
 */
export class OpenAICompatibleBackend implements LLMService {
  public readonly backend: LLMBackend;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: {
    backend: LLMBackend;
    baseUrl: string;
    apiKey: string;
    model: string;
  }) {
    this.backend = opts.backend;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  public isAvailable(): boolean {
    if (this.backend === "cloud-api") {
      return this.apiKey.length > 0 && this.model.length > 0;
    }
    return this.model.length > 0;
  }

  public async complete(
    system: string,
    user: string,
    opts?: LLMOptions,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    if (opts?.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const url = `${this.baseUrl}/v1/chat/completions`;
    const result = await proxyFetch(url, "POST", headers, JSON.stringify(body));

    if (result.status === 0) {
      throw new Error(
        `LLM network error (${this.baseUrl}): ${result.statusText}`,
      );
    }

    if (!result.ok) {
      const detail =
        extractApiErrorMessage(result.body) ||
        result.body.slice(0, 300) ||
        result.statusText ||
        "no error body";

      const isLocalOriginBlock =
        result.status === 403 &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(this.baseUrl);
      const hint = isLocalOriginBlock
        ? ' — Ollama rejects chrome-extension:// origins by default. Fix: run `OLLAMA_ORIGINS="chrome-extension://*" ollama serve` (or set via launchctl on macOS) and restart Ollama.'
        : "";

      throw new Error(
        `LLM request failed (${result.status} ${this.baseUrl}): ${detail}${hint}`,
      );
    }

    const data = JSON.parse(result.body) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }

  public async completeJSON<T>(
    system: string,
    user: string,
    parse: (raw: string) => T,
    opts?: LLMOptions,
  ): Promise<T> {
    const raw = await this.complete(system, user, {
      ...opts,
      jsonMode: opts?.jsonMode ?? true,
    });
    return parse(raw);
  }
}
