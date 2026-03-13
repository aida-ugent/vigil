export type Severity = "low" | "medium" | "high";

export interface FindingMetadata {
  moralFoundation?: string;
  demandType?: string;
  demandText?: string;
  protagonistRoles?: string[];
  extra?: Record<string, unknown>;
}

export interface Finding {
  term: string;
  label: string;
  severity: Severity;
  explanation: string;
  pluginId: string;
  spanStart?: number;
  spanEnd?: number;
  category?: string;
  confidence?: number;
  metadata?: FindingMetadata;
}

/**
 * Builds a compact metadata summary string from a finding's metadata.
 * Plugin-agnostic: renders whatever fields are present.
 * Returns null when there's nothing meaningful to show.
 */
export function formatFindingMeta(finding: Finding): string | null {
  const parts: string[] = [];
  const m = finding.metadata;

  if (m?.moralFoundation) parts.push(m.moralFoundation);
  if (m?.demandType) parts.push(`${m.demandType} demand`);
  if (m?.protagonistRoles?.length) parts.push(m.protagonistRoles.join(", "));

  if (finding.confidence != null) {
    parts.push(`${Math.round(finding.confidence * 100)}% conf.`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Builds structured metadata detail lines for expanded finding views.
 * Returns an array of { label, value } pairs. Empty array if no metadata.
 */
export function findingMetaDetails(finding: Finding): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const m = finding.metadata;
  if (!m) return rows;

  if (m.moralFoundation) rows.push({ label: "Foundation", value: m.moralFoundation });
  if (m.demandType) rows.push({ label: "Demand", value: `${m.demandType}${m.demandText ? `: "${m.demandText}"` : ""}` });
  if (m.protagonistRoles?.length) rows.push({ label: "Roles", value: m.protagonistRoles.join(", ") });

  const extra = m.extra;
  if (extra) {
    if (Array.isArray(extra.protagonists) && extra.protagonists.length > 0) {
      const formatted = (extra.protagonists as Array<{ text: string; category?: string; roles?: string[] }>)
        .map((p) => {
          const role = p.roles?.join("/") ?? "";
          return role ? `${p.text} (${role})` : p.text;
        })
        .join("; ");
      rows.push({ label: "Protagonists", value: formatted });
    }
  }

  if (finding.confidence != null) {
    rows.push({ label: "Confidence", value: `${Math.round(finding.confidence * 100)}%` });
  }

  return rows;
}

