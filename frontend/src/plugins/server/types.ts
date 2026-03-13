/** Types mirroring the backend API response shapes. */

export interface ServerPluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  requires_llm: boolean;
  can_reformulate: boolean;
  supported_labels: string[];
  active_model: string | null;
}

export interface ServerPluginsResponse {
  analyzers: ServerPluginInfo[];
  default_analyzer: string;
}

export interface ServerFinding {
  term: string;
  label: string;
  severity: "low" | "medium" | "high";
  explanation: string;
  plugin_id: string;
  category?: string;
  confidence?: number;
  span_start?: number;
  span_end?: number;
  metadata?: {
    moral_foundation?: string;
    demand_type?: string;
    demand_text?: string;
    protagonist_roles?: string[];
    extra?: Record<string, unknown>;
  };
}

export interface ServerAnalyzeResponse {
  findings: ServerFinding[];
  tips: string[];
}

export interface ServerReformulationResult {
  original_text: string;
  reformulated_text: string;
  changes: string[];
}
