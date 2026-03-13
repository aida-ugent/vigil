import type { Finding } from "../../shared/findings";
import { TECHNIQUES, TIPS, SUPPORTED_LABELS, type TriggerTechniqueDef } from "./config";
import type { BrowserPlugin, PluginAnalyzeResult, PluginContext, PluginMetadata } from "../types";

export const PLUGIN_ID = "cognitive-bias-trigger-regex";

export class CognitiveBiasTriggerRegexPlugin implements BrowserPlugin {
  public readonly metadata: PluginMetadata = {
    id: PLUGIN_ID,
    name: "Cognitive Bias Trigger Detector (Regex)",
    version: "0.1.0",
    description:
      "Fast keyword-based detection of cognitive bias triggers using the 14-type SemEval taxonomy. Zero latency, no LLM required.",
    supportedLabels: SUPPORTED_LABELS,
    requiresLLM: false,
    canReformulate: false,
  };

  public async analyze(
    text: string,
    _context: PluginContext,
  ): Promise<PluginAnalyzeResult> {
    const findings: Finding[] = [];
    const lowerText = text.toLowerCase();

    for (const tech of TECHNIQUES) {
      if (tech.terms.length === 0) continue;
      for (const term of tech.terms) {
        const lowerTerm = term.toLowerCase();
        let searchFrom = 0;

        while (true) {
          const idx = lowerText.indexOf(lowerTerm, searchFrom);
          if (idx === -1) break;

          if (!isWordBoundary(lowerText, idx, lowerTerm.length)) {
            searchFrom = idx + 1;
            continue;
          }

          findings.push(makeFinding(tech, text.slice(idx, idx + term.length), idx, term.length));
          searchFrom = idx + lowerTerm.length;
        }
      }
    }

    // Structural detection: Repetition (any phrase appearing 2+ times)
    const repetitionTech = TECHNIQUES.find((t) => t.label === "Repetition");
    if (repetitionTech) {
      for (const f of detectRepetition(text, repetitionTech)) findings.push(f);
    }

    findings.sort((a, b) => (a.spanStart ?? 0) - (b.spanStart ?? 0));
    const deduplicated = deduplicateOverlapping(findings);

    return {
      findings: deduplicated,
      tips: deduplicated.length > 0 ? TIPS : [],
    };
  }
}

const MIN_REPEAT_TOKENS = 3;
const MAX_REPEAT_TOKENS = 12;
const MIN_REPEAT_COUNT = 2;
const MIN_REPEAT_CHARS = 12;
const REPETITION_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "to", "of", "in", "on", "at", "by",
  "for", "from", "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "we", "our", "you", "your",
  "they", "their", "he", "his", "she", "her", "i", "my", "me", "not", "no",
]);

type TokenSpan = {
  token: string;
  start: number;
  end: number;
};

/**
 * Structural repetition detector: finds any phrase (3–12 words) that appears
 * at least twice in the text. Reports only the second and subsequent
 * occurrences so the highlight points to the repetition, not the first use.
 */
function detectRepetition(text: string, tech: TriggerTechniqueDef): Finding[] {
  const tokenRe = /[A-Za-z0-9']+/g;
  const tokens: TokenSpan[] = [];
  for (const match of text.matchAll(tokenRe)) {
    const raw = match[0];
    const start = match.index ?? -1;
    if (start < 0) continue;
    tokens.push({
      token: raw.toLowerCase(),
      start,
      end: start + raw.length,
    });
  }
  if (tokens.length < MIN_REPEAT_TOKENS * MIN_REPEAT_COUNT) return [];

  const hits: Finding[] = [];
  const coveredSpans: Array<[number, number]> = [];

  for (let n = MAX_REPEAT_TOKENS; n >= MIN_REPEAT_TOKENS; n--) {
    const occurrences = new Map<string, Array<{ start: number; end: number }>>();
    for (let i = 0; i <= tokens.length - n; i++) {
      const gram = tokens.slice(i, i + n);
      const first = gram[0]?.token ?? "";
      const last = gram[gram.length - 1]?.token ?? "";
      const nonStop = gram.filter((t) => !REPETITION_STOPWORDS.has(t.token)).length;

      // Avoid fragmentary n-grams like "infantry forces in".
      if (REPETITION_STOPWORDS.has(first) || REPETITION_STOPWORDS.has(last)) continue;
      if (nonStop < 2) continue;

      const start = gram[0]?.start ?? -1;
      const end = gram[gram.length - 1]?.end ?? -1;
      if (start < 0 || end <= start) continue;

      const phrase = text.slice(start, end).trim();
      if (phrase.length < MIN_REPEAT_CHARS) continue;

      const key = gram.map((t) => t.token).join(" ");
      const arr = occurrences.get(key) ?? [];
      arr.push({ start, end });
      occurrences.set(key, arr);
    }

    for (const spans of occurrences.values()) {
      if (spans.length < MIN_REPEAT_COUNT) continue;
      // mark only repeated mentions (skip first occurrence)
      for (let idx = 1; idx < spans.length; idx++) {
        const spanStart = spans[idx]?.start ?? -1;
        const spanEnd = spans[idx]?.end ?? -1;
        if (spanStart < 0 || spanEnd <= spanStart) continue;
        const overlaps = coveredSpans.some(
          ([s, e]) => spanStart < e && spanEnd > s,
        );
        if (overlaps) continue;
        const phrase = text.slice(spanStart, spanEnd);
        coveredSpans.push([spanStart, spanEnd]);
        hits.push(makeFinding(tech, phrase, spanStart, phrase.length));
      }
    }
  }

  return hits;
}

function isWordBoundary(text: string, start: number, length: number): boolean {
  const before = start > 0 ? text[start - 1] : " ";
  const after = start + length < text.length ? text[start + length] : " ";
  return !/\w/.test(before) && !/\w/.test(after);
}

function makeFinding(
  tech: TriggerTechniqueDef,
  matchedText: string,
  spanStart: number,
  termLength: number,
): Finding {
  return {
    term: matchedText,
    label: tech.label,
    severity: tech.severity,
    explanation: `${tech.description} (Triggers: ${tech.cognitiveBias})`,
    pluginId: PLUGIN_ID,
    spanStart,
    spanEnd: spanStart + termLength,
    metadata: {
      extra: { cognitiveBias: tech.cognitiveBias },
    },
  };
}

function deduplicateOverlapping(sorted: Finding[]): Finding[] {
  const result: Finding[] = [];
  let lastEnd = -1;
  for (const f of sorted) {
    const start = f.spanStart ?? 0;
    if (start >= lastEnd) {
      result.push(f);
      lastEnd = f.spanEnd ?? start;
    }
  }
  return result;
}
