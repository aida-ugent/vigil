import { z } from "zod";
import taxonomy from "../../shared/cognitive_bias_trigger_taxonomy.json";

const TECHNIQUE_LABELS = taxonomy.techniques.map((t) => t.label) as [string, ...string[]];

export const LLMTriggerFindingSchema = z.object({
  term: z.string().max(120),
  explanation: z.string().max(500),
  label: z.enum(TECHNIQUE_LABELS),
  severity: z.enum(["low", "medium", "high"]),
  cognitiveBias: z.string().max(80).optional(),
});

export const LLMTriggerResponseSchema = z.object({
  findings: z.array(LLMTriggerFindingSchema).default([]),
  tips: z.array(z.string()).default([]),
});

export type LLMTriggerFinding = z.infer<typeof LLMTriggerFindingSchema>;
export type LLMTriggerResponse = z.infer<typeof LLMTriggerResponseSchema>;

/**
 * Strips markdown code fences and parses JSON. Validates each finding
 * individually so a single invalid label doesn't discard the entire response.
 */
export function parseLLMTriggerResponse(raw: string): LLMTriggerResponse {
  let cleaned = raw.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  }

  const data = JSON.parse(cleaned) as Record<string, unknown>;

  const rawFindings = Array.isArray(data.findings) ? data.findings : [];
  const rawTips = Array.isArray(data.tips) ? data.tips : [];

  const findings: LLMTriggerFinding[] = [];
  for (const f of rawFindings) {
    const result = LLMTriggerFindingSchema.safeParse(f);
    if (result.success) {
      findings.push(result.data);
    }
  }

  const tips = rawTips
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return { findings, tips };
}
