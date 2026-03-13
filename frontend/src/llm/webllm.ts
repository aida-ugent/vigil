import { sendRuntimeMessage } from "../shared/messages";
import type { LLMOptions, LLMService } from "./types";
import {
  DEFAULT_WEBLLM_MODEL_ID,
  WEBLLM_MODELS,
  isWebLLMModelID,
  type WebLLMModelID,
} from "./webllmModels";

const INIT_TIMEOUT_MS = 5 * 60_000;
const GENERATE_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1024;

export type WebLLMStatus = "idle" | "loading" | "ready" | "error";

export interface WebLLMProgress {
  progress: number;
  text: string;
}

type ProgressListener = (progress: WebLLMProgress, status: WebLLMStatus) => void;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function fromModelId(input: string): WebLLMModelID | null {
  for (const [shortId, config] of Object.entries(WEBLLM_MODELS)) {
    if (config.modelId === input) {
      return shortId as WebLLMModelID;
    }
  }
  return null;
}

export class WebLLMLLMService implements LLMService {
  public readonly backend = "webllm" as const;

  private status: WebLLMStatus = "idle";
  private progress: WebLLMProgress = { progress: 0, text: "Model not loaded." };
  private currentModel: WebLLMModelID | null = null;
  private listeners = new Set<ProgressListener>();
  private runtimeListenerBound = false;

  constructor() {
    this.bindRuntimeListener();
  }

  public isAvailable(): boolean {
    return this.status === "ready";
  }

  public isReady(): boolean {
    return this.status === "ready";
  }

  public isLoading(): boolean {
    return this.status === "loading";
  }

  public getStatus(): WebLLMStatus {
    return this.status;
  }

  public getCurrentModel(): WebLLMModelID | null {
    return this.currentModel;
  }

  public getProgress(): WebLLMProgress {
    return { ...this.progress };
  }

  public onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.getProgress(), this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async init(model: string): Promise<void> {
    const selectedModel = isWebLLMModelID(model)
      ? model
      : DEFAULT_WEBLLM_MODEL_ID;

    if (this.status === "ready" && this.currentModel === selectedModel) {
      return;
    }

    this.status = "loading";
    this.notifyProgress({ progress: 0, text: "Initializing model..." });

    const response = await withTimeout(
      sendRuntimeMessage({
        type: "WEBLLM_INIT",
        payload: { modelId: WEBLLM_MODELS[selectedModel].modelId },
      }),
      INIT_TIMEOUT_MS,
      "WebLLM initialization",
    );

    if (!response.payload.ok) {
      this.status = "error";
      this.notifyProgress({
        progress: 0,
        text: response.payload.error ?? "Model initialization failed.",
      });
      throw new Error(response.payload.error ?? "Model initialization failed.");
    }

    this.currentModel = selectedModel;
    this.status = "ready";
    this.notifyProgress({ progress: 1, text: "Model ready." });
  }

  public async unload(): Promise<void> {
    const response = await sendRuntimeMessage({ type: "WEBLLM_UNLOAD" });
    if (!response.payload.ok) {
      this.status = "error";
      throw new Error(response.payload.error ?? "Failed to unload model.");
    }

    this.currentModel = null;
    this.status = "idle";
    this.notifyProgress({ progress: 0, text: "Model not loaded." });
  }

  public async complete(
    system: string,
    user: string,
    opts?: LLMOptions,
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("WebLLM model is not loaded. Click 'Load Model' first.");
    }

    const response = await withTimeout(
      sendRuntimeMessage({
        type: "WEBLLM_GENERATE",
        payload: {
          systemPrompt: system,
          userPrompt: user,
          temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
          maxTokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        },
      }),
      GENERATE_TIMEOUT_MS,
      "WebLLM generation",
    );

    if (!response.payload.ok) {
      throw new Error(response.payload.error ?? "WebLLM generation failed.");
    }

    return response.payload.result;
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

  private bindRuntimeListener(): void {
    if (this.runtimeListenerBound) {
      return;
    }

    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }

      const event = message as {
        type?: string;
        payload?: { progress?: number; text?: string; modelId?: string; error?: string };
      };

      if (event.type === "WEBLLM_PROGRESS" && event.payload) {
        this.status = "loading";
        const progress =
          typeof event.payload.progress === "number"
            ? Math.min(1, Math.max(0, event.payload.progress))
            : 0;
        this.notifyProgress({
          progress,
          text: event.payload.text || "Loading model...",
        });
        return;
      }

      if (event.type === "WEBLLM_READY" && event.payload?.modelId) {
        this.status = "ready";
        this.currentModel = fromModelId(event.payload.modelId);
        this.notifyProgress({ progress: 1, text: "Model ready." });
        return;
      }

      if (event.type === "WEBLLM_ERROR") {
        const message = event.payload?.error || "WebLLM error.";
        if (this.status === "loading" || this.status === "idle") {
          this.status = "error";
          this.notifyProgress({ progress: 0, text: message });
        } else {
          this.notifyProgress({ progress: 1, text: `Last error: ${message}` });
        }
      }
    });

    this.runtimeListenerBound = true;
  }

  private notifyProgress(progress: WebLLMProgress): void {
    this.progress = progress;
    for (const listener of this.listeners) {
      listener({ ...progress }, this.status);
    }
  }
}

const webLLMSingleton = new WebLLMLLMService();

export function getWebLLMService(): WebLLMLLMService {
  return webLLMSingleton;
}

export function isWebLLMService(service: LLMService): service is WebLLMLLMService {
  return service.backend === "webllm";
}
