export type WebLLMModelID = "qwen" | "llama3.2";

export interface WebLLMModelConfig {
  id: WebLLMModelID;
  name: string;
  description: string;
  size: string;
  modelId: string;
}

export const WEBLLM_MODELS: Record<WebLLMModelID, WebLLMModelConfig> = {
  qwen: {
    id: "qwen",
    name: "Qwen 2.5 0.5B",
    description: "Small and fast",
    size: "~300 MB",
    modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  },
  "llama3.2": {
    id: "llama3.2",
    name: "Llama 3.2 1B",
    description: "Higher quality, slower",
    size: "~1 GB",
    modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  },
};

export const DEFAULT_WEBLLM_MODEL_ID: WebLLMModelID = "llama3.2";

export const WEBLLM_MODEL_ORDER: WebLLMModelID[] = ["llama3.2", "qwen"];

export function isWebLLMModelID(value: string): value is WebLLMModelID {
  return value in WEBLLM_MODELS;
}
