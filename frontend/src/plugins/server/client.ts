/**
 * Server API client. Uses PROXY_FETCH message to relay HTTP through the
 * background service worker, avoiding CORS issues in the sidepanel context.
 */

import { sendRuntimeMessage } from "../../shared/messages";
import type { Finding, FindingMetadata, Severity } from "../../shared/findings";
import type {
  ServerAnalyzeResponse,
  ServerFinding,
  ServerPluginsResponse,
  ServerReformulationResult,
} from "./types";

async function proxyFetch(
  baseUrl: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const result = await sendRuntimeMessage({
    type: "PROXY_FETCH",
    payload: {
      url,
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    },
  });
  return result.payload;
}

/** Convert snake_case server finding to camelCase frontend Finding. */
function toFinding(sf: ServerFinding): Finding {
  const meta: FindingMetadata | undefined = sf.metadata
    ? {
        moralFoundation: sf.metadata.moral_foundation,
        demandType: sf.metadata.demand_type,
        demandText: sf.metadata.demand_text,
        protagonistRoles: sf.metadata.protagonist_roles,
        extra: sf.metadata.extra,
      }
    : undefined;

  return {
    term: sf.term,
    label: sf.label,
    severity: sf.severity as Severity,
    explanation: sf.explanation,
    pluginId: sf.plugin_id,
    spanStart: sf.span_start,
    spanEnd: sf.span_end,
    category: sf.category,
    confidence: sf.confidence,
    metadata: meta,
  };
}

export interface ServerClient {
  checkHealth(): Promise<boolean>;
  fetchPlugins(): Promise<ServerPluginsResponse>;
  analyze(text: string, sensitivity: number, pluginIds: string[]): Promise<{ findings: Finding[]; tips: string[] }>;
  reformulate(text: string, findings: Finding[], pluginId: string): Promise<ServerReformulationResult>;
}

export function createServerClient(baseUrl: string): ServerClient {
  return {
    async checkHealth(): Promise<boolean> {
      try {
        const res = await proxyFetch(baseUrl, "/health", "GET");
        return res.ok;
      } catch {
        return false;
      }
    },

    async fetchPlugins(): Promise<ServerPluginsResponse> {
      const res = await proxyFetch(baseUrl, "/plugins", "GET");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      return JSON.parse(res.body) as ServerPluginsResponse;
    },

    async analyze(
      text: string,
      sensitivity: number,
      pluginIds: string[],
    ): Promise<{ findings: Finding[]; tips: string[] }> {
      const res = await proxyFetch(baseUrl, "/analyze", "POST", {
        text,
        sensitivity,
        plugins: pluginIds,
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.body}`);
      const data = JSON.parse(res.body) as ServerAnalyzeResponse;
      return {
        findings: data.findings.map(toFinding),
        tips: data.tips,
      };
    },

    async reformulate(
      text: string,
      findings: Finding[],
      pluginId: string,
    ): Promise<ServerReformulationResult> {
      const serverFindings = findings.map((f) => ({
        term: f.term,
        label: f.label,
        severity: f.severity,
        explanation: f.explanation,
        plugin_id: f.pluginId,
        category: f.category,
        confidence: f.confidence,
        span_start: f.spanStart,
        span_end: f.spanEnd,
      }));
      const res = await proxyFetch(baseUrl, "/reformulate", "POST", {
        text,
        findings: serverFindings,
        plugin_id: pluginId,
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}: ${res.body}`);
      return JSON.parse(res.body) as ServerReformulationResult;
    },
  };
}
