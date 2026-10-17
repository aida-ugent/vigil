import type { Finding } from "../shared/findings";
import type { LLMOptions } from "../llm/types";

export interface ContextPost {
  key: string;
  author: string;
  url: string;
  basis: string;
  text: string;
  matchedTerms: string[];
  retrievalMethod?: "keywords" | "same-author";
}
export interface ConfirmationTrace {
  id: number;
  startedAt: number;
  elapsedMs: number;
  stage: "retrieving" | "skipped" | "calling" | "completed" | "failed" | "discarded";
  reason: string;
  current: { id: string; text: string; pageUrl: string };
  backend: string;
  model?: string;
  historyRevision?: string;
  retrieved: ContextPost[];
  request?: { system: string; user: string; options: LLMOptions };
  responses: Array<{ text: string; truncated: boolean }>;
  validation: string[];
  findings: Finding[];
}

/** One trace, in sidebar memory only. Clearing prevents late requests from restoring it. */
export class ConfirmationDiagnostics {
  private current: ConfirmationTrace | null = null;
  private sequence = 0;
  private listeners = new Set<() => void>();
  get(): ConfirmationTrace | null { return this.current; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
  begin(current: ConfirmationTrace["current"], backend: string, model?: string): number {
    const id = ++this.sequence;
    this.current = { id, startedAt: Date.now(), elapsedMs: 0, stage: "retrieving", reason: "Retrieving related history.",
      current: { ...current }, backend, model, retrieved: [], responses: [], validation: [], findings: [] };
    this.notify(); return id;
  }
  update(id: number, patch: Partial<Omit<ConfirmationTrace, "id" | "startedAt">>): void {
    if (this.current?.id !== id) return;
    this.current = { ...this.current, ...patch, elapsedMs: Date.now() - this.current.startedAt };
    this.notify();
  }
  clear(): void { this.current = null; this.notify(); }
}
export const confirmationDiagnostics = new ConfirmationDiagnostics();
