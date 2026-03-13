/**
 * Analysis orchestration service. Owns plugin routing, mode derivation,
 * cache interaction, result deduplication, and the single-item analysis flow.
 *
 * Decoupled from DOM — can be called by any UI surface (sidepanel, popup,
 * context menu) or triggered from background events.
 */

import type { Finding } from "../shared/findings";
import type { VigilSettings, AnalyzerMode } from "../shared/settings";
import type { ContentAnalysisResult, ContentItem } from "../shared/content";
import { cacheManager } from "../shared/cacheManager";
import { resolveLLMService } from "../llm/service";
import type { LLMService } from "../llm/types";
import { browserPluginRegistry } from "../plugins/registry";
import type { PluginAnalyzeResult } from "../plugins/types";
import { createServerClient, type ServerClient } from "../plugins/server/client";

// ── Types ──

export interface AnalysisPipelineResult extends PluginAnalyzeResult {
  analyzersUsed: string;
  warning?: string;
}

export interface AnalyzeSingleResult {
  result: ContentAnalysisResult;
  pipelineInfo: {
    analyzersUsed: string;
    warning?: string;
  };
}

// ── Pure helpers ──

function partitionSelectedPlugins(pluginIds: string[]): { local: string[]; llm: string[] } {
  const local: string[] = [];
  const llm: string[] = [];
  for (const id of pluginIds) {
    const plugin = browserPluginRegistry.get(id);
    if (!plugin) continue;
    if (plugin.metadata.requiresLLM) llm.push(id);
    else local.push(id);
  }
  return { local, llm };
}

/** Derive the effective analyzer mode from the current browser plugin selection. */
export function deriveAnalyzerMode(settings: VigilSettings): AnalyzerMode {
  const { local, llm } = partitionSelectedPlugins(settings.selectedBrowserPlugins);
  if (local.length > 0 && llm.length > 0) return "hybrid";
  if (llm.length > 0) return "llm-only";
  if (local.length > 0) return "regex-only";
  return "regex-only";
}

/** Returns the sorted list of active plugin IDs (browser + server). */
export function getActivePluginIds(settings: VigilSettings): string[] {
  return [...settings.selectedBrowserPlugins, ...settings.selectedPlugins].sort();
}

export function sortFindings(findings: Finding[]): Finding[] {
  const w: Record<Finding["severity"], number> = { high: 3, medium: 2, low: 1 };
  return [...findings].sort((a, b) => {
    const byS = w[b.severity] - w[a.severity];
    if (byS !== 0) return byS;
    return (a.spanStart ?? Infinity) - (b.spanStart ?? Infinity);
  });
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const isDuplicate = kept.some((existing) => {
      if (f.spanStart == null || f.spanEnd == null) return false;
      if (existing.spanStart == null || existing.spanEnd == null) return false;
      return f.spanStart < existing.spanEnd && f.spanEnd > existing.spanStart && f.label === existing.label;
    });
    if (!isDuplicate) kept.push(f);
  }
  return kept;
}

// ── Pipeline ──

/**
 * Runs the full analysis pipeline on a text string: browser plugins first,
 * then server plugins, with deduplication and merging.
 */
export async function analyzeTextWithPlugins(
  text: string,
  settings: VigilSettings,
  llm: LLMService,
  serverClient: ServerClient,
): Promise<AnalysisPipelineResult> {
  const ctx = { settings, llm };
  const { local, llm: llmPlugins } = partitionSelectedPlugins(settings.selectedBrowserPlugins);

  const llmUnavailableWarning =
    settings.llmBackend === "webllm"
      ? "Load a Browser AI model to enable LLM findings."
      : "LLM backend is unavailable. Check backend config.";

  let browserResult: AnalysisPipelineResult;

  if (settings.selectedBrowserPlugins.length === 0) {
    browserResult = { findings: [], tips: [], analyzersUsed: "none" };
  } else {
    const allFindings: Finding[] = [];
    const allTips: string[] = [];
    const tipSet = new Set<string>();
    const usedParts: string[] = [];
    let warning: string | undefined;

    const mergeTips = (tips: string[]) => {
      for (const t of tips) { if (!tipSet.has(t)) { tipSet.add(t); allTips.push(t); } }
    };

    for (const id of local) {
      const r = await browserPluginRegistry.analyzeWith(id, text, ctx);
      allFindings.push(...r.findings);
      mergeTips(r.tips);
    }
    if (local.length > 0) usedParts.push("regex");

    if (llmPlugins.length > 0) {
      if (!llm.isAvailable()) {
        warning = llmUnavailableWarning;
        usedParts.push("LLM (not ready)");
      } else {
        let llmOk = 0;
        for (const id of llmPlugins) {
          try {
            const r = await browserPluginRegistry.analyzeWith(id, text, ctx);
            allFindings.push(...r.findings);
            mergeTips(r.tips);
            llmOk++;
          } catch (error) {
            warning = error instanceof Error ? error.message : "Unknown LLM error";
          }
        }
        if (llmOk > 0) usedParts.push("LLM");
        else if (!warning) usedParts.push("LLM (failed)");
        else usedParts.push("LLM (failed)");
      }
    }

    browserResult = {
      findings: deduplicateFindings(allFindings),
      tips: allTips,
      analyzersUsed: usedParts.join(" + ") || "none",
      warning,
    };
  }

  // Server plugins (if any selected)
  const serverPlugins = settings.selectedPlugins;
  if (serverPlugins.length > 0 && settings.serverUrl) {
    try {
      const serverResult = await serverClient.analyze(text, settings.sensitivity, serverPlugins);
      const allFindings = deduplicateFindings([...browserResult.findings, ...serverResult.findings]);
      const tipSet = new Set(browserResult.tips);
      const allTips = [...browserResult.tips];
      for (const tip of serverResult.tips) { if (!tipSet.has(tip)) { tipSet.add(tip); allTips.push(tip); } }
      return {
        findings: allFindings,
        tips: allTips,
        analyzersUsed: `${browserResult.analyzersUsed} + server`,
        warning: browserResult.warning,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      console.warn("[Vigil v2] Server analysis failed:", msg);
      return {
        ...browserResult,
        analyzersUsed: `${browserResult.analyzersUsed} (server failed)`,
        warning: browserResult.warning ? `${browserResult.warning}; Server: ${msg}` : `Server: ${msg}`,
      };
    }
  }

  return browserResult;
}

/**
 * Analyzes a single content item: checks cache, runs pipeline, writes cache.
 * Returns the result without any DOM side-effects.
 */
export async function analyzeSingleItem(
  item: ContentItem,
  settings: VigilSettings,
  options: { forceRefresh?: boolean } = {},
): Promise<AnalyzeSingleResult> {
  const activePluginIds = getActivePluginIds(settings);
  const mode = deriveAnalyzerMode(settings);
  const llm = resolveLLMService(settings);
  const serverClient = createServerClient(settings.serverUrl);

  if (!options.forceRefresh) {
    const cached = await cacheManager.get(
      item.id,
      item.text,
      mode,
      settings.sensitivity,
      activePluginIds,
    );

    if (cached) {
      return {
        result: {
          id: item.id,
          text: item.text,
          findings: cached.findings,
          tips: cached.tips,
          elapsedMs: 0,
          cached: true,
        },
        pipelineInfo: {
          analyzersUsed: "cached",
        },
      };
    }
  } else {
    await cacheManager.remove(item.id);
  }

  const startedAt = performance.now();
  const pipeResult = await analyzeTextWithPlugins(item.text, settings, llm, serverClient);

  const newResult: ContentAnalysisResult = {
    id: item.id,
    text: item.text,
    findings: sortFindings(pipeResult.findings),
    tips: pipeResult.tips,
    elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)),
    cached: false,
  };

  try {
    await cacheManager.set(
      item.id, item.text, item.pageUrl, item.platform,
      newResult.findings, newResult.tips,
      activePluginIds, mode, settings.sensitivity,
    );
  } catch (error) {
    console.warn("[Vigil v2] Cache write failed", error);
  }

  return {
    result: newResult,
    pipelineInfo: {
      analyzersUsed: pipeResult.analyzersUsed,
      warning: pipeResult.warning,
    },
  };
}

/**
 * Determines if a reformulation-capable plugin produced findings.
 * Returns the plugin ID to use for reformulation, or null if none can reformulate.
 */
export function findReformulationPlugin(findings: Finding[]): string | null {
  const pluginIds = new Set(findings.map((f) => f.pluginId));
  for (const id of pluginIds) {
    const plugin = browserPluginRegistry.get(id);
    if (plugin?.metadata.canReformulate) return id;
  }
  return null;
}
