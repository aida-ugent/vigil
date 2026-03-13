import type { LLMBackend } from "../shared/settings";

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

/**
 * Unified LLM access interface. Plugins call these methods without knowing
 * whether the backend is OpenAI, Ollama, or an in-browser model.
 */
export interface LLMService {
  complete(system: string, user: string, opts?: LLMOptions): Promise<string>;
  completeJSON<T>(
    system: string,
    user: string,
    parse: (raw: string) => T,
    opts?: LLMOptions,
  ): Promise<T>;
  isAvailable(): boolean;
  readonly backend: LLMBackend;
}
