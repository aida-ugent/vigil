import { z } from "zod";

export type LLMBackend = "none" | "webllm" | "cloud-api" | "local-api";
export type Sensitivity = 1 | 2 | 3;
export type WebLLMModelId = "qwen" | "llama3.2";
export type DefaultAction = "none" | "rewrite" | "alternatives" | "delete";

/**
 * AnalyzerMode is derived at runtime from selectedBrowserPlugins,
 * never persisted. Kept as a type for API surfaces that need it.
 */
export type AnalyzerMode =
  | "hybrid"
  | "llm-only"
  | "regex-only"
  | "llm-with-regex-fallback";

const llmBackendSchema = z.enum(["none", "webllm", "cloud-api", "local-api"]);
const sensitivitySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const webllmModelSchema = z.enum(["qwen", "llama3.2"]);
const defaultActionSchema = z.enum(["none", "rewrite", "alternatives", "delete"]);
const analyzerModeSchema = z.enum(["hybrid", "llm-only", "regex-only", "llm-with-regex-fallback"]);

/**
 * Zod schema for the persisted settings shape. `.safeParse()` is used
 * on storage reads so malformed data falls back to defaults gracefully.
 */
const vigilSettingsSchema = z.object({
  version: z.literal(1).optional().default(1),
  llmBackend: llmBackendSchema.catch("none"),
  sensitivity: sensitivitySchema.catch(2),
  autoAnalyze: z.boolean().catch(false),
  defaultAction: defaultActionSchema.catch("none"),
  serverUrl: z.string().min(1).catch("http://localhost:8787"),
  selectedPlugins: z.array(z.string()).catch([]),
  selectedBrowserPlugins: z.array(z.string()).catch(["cognitive-bias-trigger-regex"]),
  cloudApiKey: z.string().catch(""),
  cloudApiBaseUrl: z.string().min(1).catch("https://api.openai.com"),
  cloudModelId: z.string().min(1).catch("gpt-4o-mini"),
  localApiBaseUrl: z.string().min(1).catch("http://localhost:11434"),
  localModelId: z.string().min(1).catch("llama3.2"),
  webllmModelId: webllmModelSchema.catch("qwen"),
});

/**
 * Canonical persisted settings shape for extension v2.
 *
 * `analyzerMode` was removed from persistence — it is now a
 * pure function of `selectedBrowserPlugins` (see analysisService.ts).
 */
export type VigilSettings = z.infer<typeof vigilSettingsSchema>;

export const DEFAULT_SETTINGS: VigilSettings = {
  version: 1,
  llmBackend: "none",
  sensitivity: 2,
  autoAnalyze: false,
  defaultAction: "none",
  serverUrl: "http://localhost:8787",
  selectedPlugins: [],
  selectedBrowserPlugins: ["cognitive-bias-trigger-regex"],
  cloudApiKey: "",
  cloudApiBaseUrl: "https://api.openai.com",
  cloudModelId: "gpt-4o-mini",
  localApiBaseUrl: "http://localhost:11434",
  localModelId: "llama3.2",
  webllmModelId: "qwen",
};

/** Single storage key for the full settings object (atomic read/write). */
export const SETTINGS_KEY = "vigilSettingsV1";

/** Migrate old analyzerMode into selectedBrowserPlugins for pre-existing settings. */
function migrateBrowserPlugins(raw: Record<string, unknown>): string[] | undefined {
  if (raw.selectedBrowserPlugins != null) return undefined;
  const mode = analyzerModeSchema.catch("hybrid").parse(raw.analyzerMode);
  if (mode === "llm-only") return ["cognitive-bias-trigger-llm"];
  if (mode === "regex-only") return ["cognitive-bias-trigger-regex"];
  return ["cognitive-bias-trigger-regex", "cognitive-bias-trigger-llm"];
}

/**
 * Validates and normalizes raw storage data into a well-typed VigilSettings.
 * Uses Zod `.catch()` on every field so malformed values fall back to defaults
 * instead of throwing.
 */
export function normalizeSettings(raw: unknown): VigilSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const migrated = migrateBrowserPlugins(source);
  if (migrated) {
    source.selectedBrowserPlugins = migrated;
  }

  return vigilSettingsSchema.parse(source);
}
