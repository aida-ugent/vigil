import type { VigilSettings } from "../shared/settings";
import type { LLMService } from "./types";
import { NullLLMService } from "./null";
import { OpenAICompatibleBackend } from "./openai";
import { getWebLLMService } from "./webllm";

/**
 * Resolves the active LLMService instance from the current user settings.
 * A new instance is created on every call — callers should cache when
 * settings haven't changed.
 */
export function resolveLLMService(settings: VigilSettings): LLMService {
  switch (settings.llmBackend) {
    case "cloud-api":
      return new OpenAICompatibleBackend({
        backend: "cloud-api",
        baseUrl: settings.cloudApiBaseUrl,
        apiKey: settings.cloudApiKey,
        model: settings.cloudModelId,
      });

    case "local-api":
      return new OpenAICompatibleBackend({
        backend: "local-api",
        baseUrl: settings.localApiBaseUrl,
        apiKey: "",
        model: settings.localModelId,
      });

    case "webllm":
      return getWebLLMService();

    case "none":
    default:
      return new NullLLMService("none");
  }
}
