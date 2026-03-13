import type { Finding } from "../shared/findings";
import type { VigilSettings } from "../shared/settings";
import type { LLMService } from "../llm/types";

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  supportedLabels: string[];
  requiresLLM: boolean;
  canReformulate: boolean;
}

export interface PluginContext {
  settings: VigilSettings;
  llm?: LLMService;
  maxFindings?: number;
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

