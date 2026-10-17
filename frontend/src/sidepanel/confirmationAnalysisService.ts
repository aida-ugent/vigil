import { confirmationDiagnostics, type ConfirmationDiagnostics } from "../diagnostics/confirmation";
import { getActivitySettings, tokens, preferenceText, isOwnPost } from "../activity/model";
import { related, revision } from "../activity/database";
import { detectConfirmationBias } from "../plugins/confirmationBias";
import type { ContentAnalysisResult, ContentItem } from "../shared/content";
import type { LLMService } from "../llm/types";

interface AnalysisRequest {
  item: ContentItem;
  base: ContentAnalysisResult;
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

  constructor(private readonly callbacks: AnalysisCallbacks, private readonly diagnostics: ConfirmationDiagnostics = confirmationDiagnostics) {}

  async analyze(request: AnalysisRequest): Promise<void> {
    if (!this.callbacks.isCurrent(request)) return;
    if (this.busy) {
      this.pending = request;
      return;
    }

    this.busy = true;
    const trace = this.diagnostics.begin({ id: request.item.id, text: request.item.text, pageUrl: request.item.pageUrl }, request.llm.backend, request.model);
    const finish = (stage: "skipped" | "failed" | "discarded", reason: string) => this.diagnostics.update(trace, { stage, reason });
    const status = (message: string): void => {
      if (this.callbacks.isCurrent(request)) this.callbacks.onStatus(message);
    };

    try {
      if (!(await getActivitySettings()).confirmation) { finish("skipped", "Confirmation-bias detection is disabled."); return; }
      const { item, base, llm } = request;
      const evidence = await related(
        item.text,
        item.platform === "twitter" ? item.id : undefined,
        item.platform === "twitter" ? item.author : undefined,
      );
      const queryTerms = tokens(item.text).slice(0, 24);
      this.diagnostics.update(trace, {
        historyRevision: evidence.revision,
        retrieved: evidence.posts.map(p => ({ key: p.key, author: p.author, url: p.url,
          basis: isOwnPost(p) ? (p.liked ? "authored-and-liked" : "authored") : "liked",
          text: preferenceText(p).slice(0, 1500),
          retrievalMethod: evidence.retrievalMethod,
          matchedTerms: queryTerms.filter(t => tokens(preferenceText(p)).includes(t)),
        })),
      });
      if (!this.callbacks.isCurrent(request)) { finish("discarded", "The page or analysis settings changed during retrieval."); return; }
      if (!evidence.ready) {
        finish("skipped", "Insufficient relevant history: need two distinct liked/authored posts from one known viewing account.");
        status(`Need 2 distinct relevant liked or self-authored posts from one known viewing account; retrieved ${evidence.posts.length}.`);
        return;
      }
      if (!llm.isAvailable()) {
        finish("skipped", "The configured LLM is not available.");
        status("Configure an LLM in Settings to detect confirmation bias.");
        return;
      }

      status("Checking for possible confirmation bias…");
      const responses: Array<{ text: string; truncated: boolean }> = [];
      const validation: string[] = [];
      const findings = await detectConfirmationBias(item.text, evidence, llm, {
        onRequest: payload => this.diagnostics.update(trace, { stage: "calling", reason: "LLM request started.", request: payload }),
        onResponse: raw => {
          responses.push({ text: raw.slice(0, 50000), truncated: raw.length > 50000 });
          this.diagnostics.update(trace, { responses: responses.slice(-3) });
        },
        onValidation: message => {
          validation.push(message);
          this.diagnostics.update(trace, { validation: [...validation] });
        },
      });
      const settings = await getActivitySettings();
      const historyRevision = await revision();
      if (
        !this.callbacks.isCurrent(request) ||
        !settings.confirmation ||
        historyRevision !== evidence.revision
      ) {
        finish("discarded", "Result discarded because the page, settings, or activity history changed during inference.");
        return;
      }

      await this.callbacks.onResult(request, {
        ...base,
        findings: [...base.findings, ...findings],
      });
      this.diagnostics.update(trace, { stage: "completed", findings,
        reason: findings.length ? "Confirmation-bias finding returned." : validation.length ? "Response received, but findings failed validation." : "Model abstained: no supported finding returned." });
      status(
        findings.length
          ? `${findings.length} possible confirmation-bias finding(s).`
          : "No supported confirmation-bias finding for this content.",
      );
    } catch (error) {
      // Provider errors may contain URLs, credentials or response bodies; do not copy them into the trace.
      finish("failed", "Analysis failed. Inspect the response/validation details if present; otherwise check your LLM connection and configuration.");
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
