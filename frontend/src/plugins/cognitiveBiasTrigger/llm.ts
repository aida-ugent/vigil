import type { Finding } from "../../shared/findings";
import taxonomy from "../../shared/cognitive_bias_trigger_taxonomy.json";
import type { BrowserPlugin, PluginAnalyzeResult, PluginContext, PluginMetadata, ReformulationResult } from "../types";
import { SUPPORTED_LABELS } from "./config";
import { parseLLMTriggerResponse } from "./llmSchema";
import { performTriggerReformulation } from "./reformulation";

export const PLUGIN_ID = "cognitive-bias-trigger-llm";

const DEFAULT_MAX_FINDINGS = 64;

const SYSTEM_PROMPT: string = taxonomy.systemPrompt;
const MAX_TEXT_LENGTH: number = taxonomy.maxTextLength;

const COGNITIVE_BIAS_BY_LABEL: Record<string, string> = Object.fromEntries(
  taxonomy.techniques.map((t) => [t.label, t.cognitiveBias]),
);

function buildUserPrompt(text: string): string {
  return (
    `${taxonomy.userPromptPrefix}\n\n` +
    `TEXT:\n${text}\n\n` +
    taxonomy.userPromptSuffix
  );
}

function resolveSpan(
  text: string,
  term: string,
  usedOffsets: Set<number>,
): { spanStart: number; spanEnd: number } | undefined {
  if (!term) return undefined;

  const lower = text.toLowerCase();
  const termLower = term.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < lower.length) {
    const idx = lower.indexOf(termLower, searchFrom);
    if (idx === -1) break;
    if (!usedOffsets.has(idx)) {
      usedOffsets.add(idx);
      return { spanStart: idx, spanEnd: idx + term.length };
    }
    searchFrom = idx + 1;
  }

  return undefined;
}

export class CognitiveBiasTriggerLLMPlugin implements BrowserPlugin {
  public readonly metadata: PluginMetadata = {
    id: PLUGIN_ID,
    name: "Cognitive Bias Trigger Detector (LLM)",
    version: "0.1.0",
    description:
      "Detects rhetorical patterns that exploit cognitive biases, using a 14-type taxonomy grounded in SemEval-2020 Task 11.",
    supportedLabels: SUPPORTED_LABELS,
    requiresLLM: true,
    canReformulate: true,
  };

  public async analyze(
    text: string,
    context: PluginContext,
  ): Promise<PluginAnalyzeResult> {
    const llm = context.llm;
    if (!llm || !llm.isAvailable()) {
      return { findings: [], tips: [] };
    }

    const truncated = text.slice(0, MAX_TEXT_LENGTH);
    const userPrompt = buildUserPrompt(truncated);
    const maxFindings = context.maxFindings ?? DEFAULT_MAX_FINDINGS;

    const parsed = await llm.completeJSON(
      SYSTEM_PROMPT,
      userPrompt,
      parseLLMTriggerResponse,
      { temperature: 0.2, jsonMode: true },
    );

    const usedOffsets = new Set<number>();
    const findings: Finding[] = [];

    for (const item of parsed.findings.slice(0, maxFindings)) {
      if (!item.term || !item.label || !item.explanation) continue;

      const span = resolveSpan(text, item.term, usedOffsets);
      const cognitiveBias = item.cognitiveBias || COGNITIVE_BIAS_BY_LABEL[item.label] || "";

      findings.push({
        term: item.term,
        label: item.label,
        severity: item.severity,
        explanation: item.explanation,
        pluginId: PLUGIN_ID,
        spanStart: span?.spanStart,
        spanEnd: span?.spanEnd,
        metadata: cognitiveBias ? { extra: { cognitiveBias } } : undefined,
      });
    }

    const tips = parsed.tips
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, 5);

    return { findings, tips };
  }

  public async reformulate(
    text: string,
    findings: Finding[],
    context: PluginContext,
  ): Promise<ReformulationResult | null> {
    const llm = context.llm;
    if (!llm || !llm.isAvailable()) return null;
    return performTriggerReformulation(text, findings, llm);
  }
}
