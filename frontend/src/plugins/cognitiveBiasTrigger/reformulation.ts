import { z } from "zod";
import type { Finding } from "../../shared/findings";
import type { LLMService } from "../../llm/types";
import type { ReformulationResult } from "../types";

const MAX_TEXT_LENGTH = 1500;

const ReformulationChangeSchema = z.object({
  original: z.string(),
  reformulated: z.string(),
  reason: z.string().default(""),
});

const ReformulationResponseSchema = z.object({
  reformulated_text: z.string(),
  changes: z.array(ReformulationChangeSchema).default([]),
});

export type ReformulationChange = z.infer<typeof ReformulationChangeSchema>;

const SYSTEM_PROMPT =
  "You are a text reformulation assistant specializing in neutralizing cognitive bias triggers. " +
  "You rewrite manipulative rhetorical patterns to be more neutral and informative, " +
  "while preserving the factual content and original meaning.\n\n" +
  "Return your response as valid JSON:\n" +
  "{\n" +
  '  "reformulated_text": "The full reformulated text",\n' +
  '  "changes": [\n' +
  "    {\n" +
  '      "original": "manipulative phrase",\n' +
  '      "reformulated": "neutral phrase",\n' +
  '      "reason": "brief explanation of what bias trigger this neutralizes"\n' +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "Rules:\n" +
  "- Preserve the factual content\n" +
  "- Replace emotionally loaded language with neutral equivalents\n" +
  "- Remove or rephrase fear appeals, false dichotomies, and identity exploitation\n" +
  "- Keep the same structure and approximate length\n" +
  "- Preserve all @mentions, #hashtags, URLs, and emojis exactly as they appear\n" +
  "- Return ONLY valid JSON";

function buildUserPrompt(
  text: string,
  findings: Finding[],
  preservedElements: string[],
): string {
  const triggerTerms = findings
    .map((f) => {
      const bias = f.metadata?.extra?.cognitiveBias ?? "";
      const biasNote = bias ? ` [triggers: ${bias}]` : "";
      return `- "${f.term}" (${f.label}${biasNote})`;
    })
    .join("\n");

  let prompt =
    "Reformulate this text to neutralize cognitive bias triggers:\n\n" +
    `TEXT:\n${text.slice(0, MAX_TEXT_LENGTH)}\n\n` +
    `BIAS TRIGGERS TO NEUTRALIZE:\n${triggerTerms}`;

  if (preservedElements.length > 0) {
    prompt +=
      "\n\nPRESERVE EXACTLY (do not modify):\n" +
      preservedElements.map((e) => `- ${e}`).join("\n");
  }

  prompt += "\n\nReturn ONLY valid JSON with the reformulated text and changes.";
  return prompt;
}

function extractPreservedElements(text: string): string[] {
  const elements: string[] = [];
  const mentionRe = /@\w+/g;
  const hashtagRe = /#\w+/g;
  const urlRe = /https?:\/\/\S+/g;

  for (const match of text.matchAll(mentionRe)) elements.push(match[0]);
  for (const match of text.matchAll(hashtagRe)) elements.push(match[0]);
  for (const match of text.matchAll(urlRe)) elements.push(match[0]);

  return [...new Set(elements)];
}

function parseResponse(raw: string): z.infer<typeof ReformulationResponseSchema> {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  }
  const data: unknown = JSON.parse(cleaned);
  const result = ReformulationResponseSchema.safeParse(data);
  if (result.success) return result.data;

  console.warn("[Vigil v2] Trigger reformulation response failed Zod validation", result.error.issues);
  return { reformulated_text: "", changes: [] };
}

export async function performTriggerReformulation(
  text: string,
  findings: Finding[],
  llm: LLMService,
): Promise<ReformulationResult | null> {
  if (!llm.isAvailable()) return null;
  if (findings.length === 0) return null;

  const preserved = extractPreservedElements(text);
  const userPrompt = buildUserPrompt(text, findings, preserved);

  const parsed = await llm.completeJSON(SYSTEM_PROMPT, userPrompt, parseResponse, {
    temperature: 0.3,
    jsonMode: true,
  });

  if (!parsed.reformulated_text) return null;

  const changes = parsed.changes
    .filter((c) => c.original && c.reformulated)
    .map((c) => {
      const reason = c.reason ? ` — ${c.reason}` : "";
      return `"${c.original}" → "${c.reformulated}"${reason}`;
    });

  return {
    originalText: text,
    reformulatedText: parsed.reformulated_text,
    changes,
  };
}
