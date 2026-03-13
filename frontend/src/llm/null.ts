import type { LLMBackend } from "../shared/settings";
import type { LLMOptions, LLMService } from "./types";

/**
 * Stub LLM service for when no backend is configured ("none") or the
 * backend is not yet wired ("webllm" before Phase 8).
 */
export class NullLLMService implements LLMService {
  public readonly backend: LLMBackend;

  constructor(backend: LLMBackend = "none") {
    this.backend = backend;
  }

  public isAvailable(): boolean {
    return false;
  }

  public async complete(
    _system: string,
    _user: string,
    _opts?: LLMOptions,
  ): Promise<string> {
    throw new Error(`LLM backend "${this.backend}" is not available.`);
  }

  public async completeJSON<T>(
    _system: string,
    _user: string,
    _parse: (raw: string) => T,
    _opts?: LLMOptions,
  ): Promise<T> {
    throw new Error(`LLM backend "${this.backend}" is not available.`);
  }
}
