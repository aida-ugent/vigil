import {
  confirmationDiagnostics,
  type ConfirmationDiagnostics,
} from "../diagnostics/confirmation";
import {
  tokens,
  preferenceText,
  isOwnPost,
  DRAIN_BATCH,
  validEmbedding,
} from "../activity/model";
import { related, revision } from "../activity/database";
import { browserPluginRegistry } from "../plugins/registry";
import { CONFIRMATION_PLUGIN_ID } from "../shared/confirmation";
import { getSettings } from "../shared/settingsStorage";
import type { ContentAnalysisResult, ContentItem } from "../shared/content";
import type { LLMService } from "../llm/types";
import { sendRuntimeMessage } from "../shared/messages";

/** Prepares a bounded batch of saved-post vectors before embedding the current text. A failure here must not
 * block analysis, so it degrades to lexical-only retrieval; the reason is reported rather than
 * swallowed, because a silently inert semantic pass is indistinguishable from a poor one. */
async function queryVector(
  text: string,
): Promise<{ vector?: Float32Array; pending: number; error?: string }> {
  try {
    const response = await sendRuntimeMessage({
      type: "ACTIVITY_EMBED",
      payload: { query: text.slice(0, 1500), drain: DRAIN_BATCH },
    });
    const { ok, vector, pending, error } = response.payload;
    if (!ok || !vector)
      return { pending, error: error ?? "The embedder returned no vector." };
    const normalized = Float32Array.from(vector);
    if (!validEmbedding(normalized))
      return { pending, error: "The embedder returned an invalid vector." };
    return { vector: normalized, pending };
  } catch (error) {
    return {
      pending: 0,
      error:
        error instanceof Error ? error.message : "Embedding request failed.",
    };
  }
}

interface AnalysisRequest {
  item: ContentItem;
  base: ContentAnalysisResult;
  /** Resolves after ordinary findings have been rendered; inference can overlap this work. */
  baseReady?: Promise<ContentAnalysisResult>;
  requestToken?: symbol;
  queuedAt?: number;
  generation: number;
  tabId: number | null;
  llm: LLMService;
  model?: string;
}

interface AnalysisCallbacks {
  isCurrent(request: AnalysisRequest): boolean;
  onStatus(message: string): void;
  onResult(
    request: AnalysisRequest,
    result: ContentAnalysisResult,
  ): Promise<void>;
}

/**
 * Runs personalized analysis independently of the existing detector pipeline.
 * Keeps only the latest pending request to avoid building a queue during scrolling.
 * Results are never written to the existing, history-independent analysis cache.
 */
export class ConfirmationAnalysisService {
  private busy = false;
  private pending: AnalysisRequest | null = null;

  constructor(
    private readonly callbacks: AnalysisCallbacks,
    private readonly diagnostics: ConfirmationDiagnostics = confirmationDiagnostics,
  ) {}

  cancelPending(): void {
    this.pending = null;
  }

  async analyze(request: AnalysisRequest): Promise<void> {
    if (!this.callbacks.isCurrent(request)) return;
    const queuedAt = request.queuedAt ?? performance.now();
    if (this.busy) {
      this.pending = { ...request, queuedAt };
      return;
    }

    this.busy = true;
    const trace = this.diagnostics.begin(
      {
        id: request.item.id,
        text: request.item.text,
        pageUrl: request.item.pageUrl,
      },
      request.llm.backend,
      request.model,
    );
    const timings: Record<string, number> = {
      queueMs: Math.round(performance.now() - queuedAt),
    };
    const timed = async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      const start = performance.now();
      try {
        return await work();
      } finally {
        timings[name] = Math.round(performance.now() - start);
        this.diagnostics.update(trace, { timings: { ...timings } });
      }
    };
    const baseReady = request.baseReady ?? Promise.resolve(request.base);
    // Observe early rejection even if a cloud call is still running.
    void baseReady.catch(() => {});
    const finish = (
      stage: "skipped" | "failed" | "discarded",
      reason: string,
    ) => this.diagnostics.update(trace, { stage, reason });
    const status = (message: string): void => {
      if (this.callbacks.isCurrent(request)) this.callbacks.onStatus(message);
    };

    try {
      if (
        !(await getSettings()).selectedBrowserPlugins.includes(
          CONFIRMATION_PLUGIN_ID,
        ) ||
        !this.callbacks.isCurrent(request)
      ) {
        finish("skipped", "Confirmation-bias detection is disabled.");
        return;
      }
      const { item, llm } = request;
      if (!llm.isAvailable()) {
        finish("skipped", "The configured LLM is not available.");
        status("Configure an LLM in Settings to detect confirmation bias.");
        return;
      }
      status("Preparing local semantic context…");
      const embedding = await timed("embeddingMs", () =>
        queryVector(item.text),
      );
      const evidence = await timed("retrievalMs", () =>
        related(
          item.text,
          embedding.vector,
          item.platform === "twitter" ? item.id : undefined,
        ),
      );
      // Only the discriminative terms are reported: showing filler as "matching" misleads.
      const queryTerms = evidence.queryTerms ?? tokens(item.text).slice(0, 24);
      this.diagnostics.update(trace, {
        historyRevision: evidence.revision,
        embedding: {
          ok: !!embedding.vector,
          pending: embedding.pending,
          error: embedding.error,
        },
        retrieved: evidence.posts.map((p) => ({
          key: p.key,
          author: p.author,
          url: p.url,
          basis: isOwnPost(p)
            ? p.liked
              ? "authored-and-liked"
              : "authored"
            : "liked",
          text: preferenceText(p).slice(0, 1500),
          retrievalMethod:
            evidence.matchMethods?.[p.key] ?? evidence.retrievalMethod,
          similarity: evidence.similarity?.[p.key],
          matchedTerms: queryTerms.filter((t) =>
            tokens(preferenceText(p)).includes(t),
          ),
        })),
      });
      if (!this.callbacks.isCurrent(request)) {
        finish(
          "discarded",
          "The page or analysis settings changed during retrieval.",
        );
        return;
      }
      if (!evidence.ready) {
        finish(
          "skipped",
          "Insufficient relevant history: need two distinct liked/authored posts from one known viewing account.",
        );
        status(
          `Need 2 distinct relevant liked or self-authored posts from one known viewing account; retrieved ${evidence.posts.length}.`,
        );
        return;
      }
      // Do not contend for the same local model; cloud HTTP requests can overlap.
      if (llm.backend !== "cloud-api") {
        await timed("baseWaitMs", () => baseReady);
        if (!this.callbacks.isCurrent(request)) {
          finish(
            "discarded",
            "The page or analysis changed while waiting for the ordinary detector.",
          );
          return;
        }
      }

      // Re-read the switch after retrieval/model waits: disabling must prevent a new request.
      const pluginSettings = await getSettings();
      if (
        !pluginSettings.selectedBrowserPlugins.includes(
          CONFIRMATION_PLUGIN_ID,
        ) ||
        !this.callbacks.isCurrent(request)
      ) {
        finish(
          "discarded",
          "Confirmation-bias detection was disabled or analysis changed.",
        );
        return;
      }
      status("Checking for possible confirmation bias…");
      const responses: Array<{ text: string; truncated: boolean }> = [];
      const validation: string[] = [];
      const { findings } = await timed("inferenceMs", () =>
        browserPluginRegistry.analyzeWith(CONFIRMATION_PLUGIN_ID, item.text, {
          settings: pluginSettings,
          evidence,
          llm,
          isCurrent: () => this.callbacks.isCurrent(request),
          diagnostics: {
            onRequest: (payload) =>
              this.diagnostics.update(trace, {
                stage: "calling",
                reason: "LLM request started.",
                request: payload,
              }),
            onResponse: (raw) => {
              responses.push({
                text: raw.slice(0, 50000),
                truncated: raw.length > 50000,
              });
              this.diagnostics.update(trace, {
                responses: responses.slice(-3),
              });
            },
            onValidation: (message) => {
              validation.push(message);
              this.diagnostics.update(trace, { validation: [...validation] });
            },
          },
        }),
      );
      const base =
        llm.backend === "cloud-api"
          ? await timed("baseWaitMs", () => baseReady)
          : await baseReady;
      const settings = await getSettings();
      const historyRevision = await revision();
      if (
        !this.callbacks.isCurrent(request) ||
        !settings.selectedBrowserPlugins.includes(CONFIRMATION_PLUGIN_ID) ||
        historyRevision !== evidence.revision
      ) {
        finish(
          "discarded",
          "Result discarded because the page, settings, or activity history changed during inference.",
        );
        return;
      }

      await this.callbacks.onResult(request, {
        ...base,
        findings: [...base.findings, ...findings],
      });
      this.diagnostics.update(trace, {
        stage: "completed",
        findings,
        reason: findings.length
          ? "Confirmation-bias finding returned."
          : validation.length
            ? "Response received, but findings failed validation."
            : "Model abstained: no supported finding returned.",
      });
      status(
        findings.length
          ? `${findings.length} possible confirmation-bias finding(s).`
          : "No supported confirmation-bias finding for this content.",
      );
    } catch (error) {
      // Provider errors may contain URLs, credentials or response bodies; do not copy them into the trace.
      finish(
        "failed",
        "Analysis failed. Inspect the response/validation details if present; otherwise check your LLM connection and configuration.",
      );
      console.warn("[Vigil confirmation] Analysis failed", error);
      status(
        "Confirmation-bias analysis unavailable. Existing findings are unchanged.",
      );
    } finally {
      this.busy = false;
      const pending = this.pending;
      this.pending = null;
      if (pending) void this.analyze(pending);
    }
  }
}
