import type { Evidence } from "../activity/model";
import type { Finding } from "../shared/findings";
import type { VigilSettings } from "../shared/settings";
import type { LLMOptions, LLMService } from "../llm/types";

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  supportedLabels: string[];
  requiresLLM: boolean;
  /** History-dependent plugins run outside the ordinary analysis cache. */
  requiresHistory?: boolean;
  canReformulate: boolean;
}

export interface PluginDiagnosticHooks {
  onRequest?(request: { system: string; user: string; options: LLMOptions }): void;
  onResponse?(raw: string): void;
  onValidation?(message: string): void;
}

export interface PluginContext {
  settings: VigilSettings;
  llm?: LLMService;
  maxFindings?: number;
  evidence?: Evidence;
  diagnostics?: PluginDiagnosticHooks;
  isCurrent?: () => boolean;
}

export interface PluginAnalyzeResult {
  findings: Finding[];
  tips: string[];
}

export interface ReformulationResult {
  originalText: string;
  reformulatedText: string;
  changes: string[];
}

export interface BrowserPlugin {
  metadata: PluginMetadata;
  analyze(text: string, context: PluginContext): Promise<PluginAnalyzeResult>;
  reformulate?(text: string, findings: Finding[], context: PluginContext): Promise<ReformulationResult | null>;
}

