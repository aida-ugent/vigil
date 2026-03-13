import * as webllm from "@mlc-ai/web-llm";
import type { RuntimeEventMessage } from "../shared/messages";
import {
  isOffscreenRequestMessage,
  type OffscreenResponseMessage,
} from "./messages";

let engine: webllm.MLCEngineInterface | null = null;
let currentModelId: string | null = null;

function sendEvent(event: RuntimeEventMessage): void {
  void chrome.runtime.sendMessage(event).catch(() => {
    // No listeners is a valid state.
  });
}

function sendProgress(progress: number, text: string): void {
  sendEvent({ type: "WEBLLM_PROGRESS", payload: { progress, text } });
}

function sendReady(modelId: string): void {
  sendEvent({ type: "WEBLLM_READY", payload: { modelId } });
}

function sendError(error: string): void {
  sendEvent({ type: "WEBLLM_ERROR", payload: { error } });
}

function sendResult(result: string): void {
  sendEvent({ type: "WEBLLM_RESULT", payload: { result } });
}

async function unloadModel(): Promise<void> {
  if (engine) {
    await engine.unload();
  }
  engine = null;
  currentModelId = null;
}

async function initModel(modelId: string): Promise<void> {
  if (engine && currentModelId === modelId) {
    sendProgress(1, "Model ready");
    sendReady(modelId);
    return;
  }

  if (engine && currentModelId !== modelId) {
    await unloadModel();
  }

  sendProgress(0, "Checking WebGPU support...");
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    }
  ).gpu;
  if (!gpu) {
    throw new Error("WebGPU is not available in this offscreen context.");
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No WebGPU adapter found.");
  }

  sendProgress(0.03, "Starting WebLLM engine...");
  engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback(report) {
      const progress = typeof report.progress === "number" ? report.progress : 0;
      let text = report.text || "Loading model...";
      if (text.includes("Loading model")) {
        text = "Loading model weights...";
      } else if (text.includes("Downloading")) {
        text = "Downloading model...";
      } else if (text.includes("Compiling")) {
        text = "Compiling shaders...";
      }
      sendProgress(progress, text);
    },
  });

  currentModelId = modelId;
  sendProgress(1, "Model ready");
  sendReady(modelId);
}

async function generate(
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<string> {
  if (!engine) {
    throw new Error("Model is not initialized.");
  }

  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  });

  return response.choices[0]?.message?.content ?? "";
}

function sendSafeResponse(
  sendResponse: (response?: OffscreenResponseMessage) => void,
  response: OffscreenResponseMessage,
): void {
  try {
    sendResponse(response);
  } catch {
    // If the sender is gone, there is nothing to do.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isOffscreenRequestMessage(message)) {
    return;
  }

  const request = message;

  void (async () => {
    try {
      if (request.type === "OFFSCREEN_WEBLLM_INIT") {
        await initModel(request.payload.modelId);
        sendSafeResponse(sendResponse, { ok: true });
        return;
      }

      if (request.type === "OFFSCREEN_WEBLLM_GENERATE") {
        const result = await generate(
          request.payload.systemPrompt,
          request.payload.userPrompt,
          request.payload.temperature,
          request.payload.maxTokens,
        );
        sendResult(result);
        sendSafeResponse(sendResponse, { ok: true, result });
        return;
      }

      if (request.type === "OFFSCREEN_WEBLLM_UNLOAD") {
        await unloadModel();
        sendSafeResponse(sendResponse, { ok: true });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "WebLLM operation failed.";
      sendError(message);
      sendSafeResponse(sendResponse, { ok: false, error: message });
    }
  })();

  return true;
});
