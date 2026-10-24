import {
  confirmationDiagnostics,
  type ConfirmationDiagnostics,
  type ConfirmationTrace,
} from "./confirmation";
import "./view.css";

declare const __VIGIL_BUILD_ID__: string;
const buildId =
  typeof __VIGIL_BUILD_ID__ === "undefined"
    ? "development"
    : __VIGIL_BUILD_ID__;

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}
function section(title: string, text: string, key: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.dataset.section = key;
  const summary = document.createElement("summary");
  summary.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  return details;
}
function safePostLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      /^(www\.)?(x\.com|twitter\.com)$/.test(parsed.hostname)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function renderConfirmationTrace(
  target: HTMLElement,
  trace: ConfirmationTrace | null,
): void {
  const opened = new Set(
    Array.from(
      target.querySelectorAll<HTMLDetailsElement>("details[open]"),
    ).map((d) => d.dataset.section),
  );
  target.replaceChildren();
  target.append(paragraph(`Vigil build: ${buildId}`));
  if (!trace) {
    target.append(
      paragraph(
        "No confirmation check recorded in this sidebar session. Click Analyze on a post to run a check alongside the existing detectors.",
      ),
    );
    return;
  }
  const summary = document.createElement("h2");
  summary.textContent = trace.stage;
  target.append(
    summary,
    paragraph(trace.reason),
    paragraph(
      `${new Date(trace.startedAt).toLocaleString()} · ${trace.elapsedMs} ms · ${trace.backend}${trace.model ? ` · ${trace.model}` : ""}`,
    ),
  );
  if (trace.timings) {
    const labels: Record<string, string> = {
      queueMs: "CB queue",
      embeddingMs: "Embedding / indexing",
      retrievalMs: "History retrieval",
      inferenceMs: "CB LLM",
      baseWaitMs: "Waiting for ordinary results",
    };
    target.append(
      paragraph(
        Object.entries(trace.timings)
          .map(
            ([key, ms]) => `${labels[key] ?? key}: ${ms.toLocaleString()} ms`,
          )
          .join(" · "),
      ),
    );
  }
  target.append(section("Current content", trace.current.text, "current"));
  const contextHeading = document.createElement("h2");
  contextHeading.textContent = trace.request
    ? "Tweets sent to the LLM"
    : "Retrieved candidates — not sent";
  target.append(contextHeading);
  const sent = trace.request
    ? (JSON.parse(trace.request.user).history as Array<{
        key: string;
        author: string;
        url: string;
        basis: string;
        text: string;
      }>)
    : trace.retrieved;
  const methods = new Set(trace.retrieved.map((p) => p.retrievalMethod));
  const method =
    methods.has("hybrid") || (methods.has("semantic") && methods.has("lexical"))
      ? "hybrid"
      : methods.has("semantic")
        ? "semantic"
        : "lexical";
  if (trace.embedding)
    target.append(
      paragraph(
        trace.embedding.ok
          ? trace.embedding.pending === 0
            ? "Semantic index ready: no pending vectors in the latest 2,000 preferences."
            : `Semantic pass active. ${trace.embedding.pending} eligible post(s) still awaiting a vector in the latest 2,000 preferences. Background indexing continues while this extension context remains open.`
          : `Semantic pass unavailable, so retrieval used keywords only: ${trace.embedding.error ?? "unknown reason"}`,
      ),
    );
  target.append(
    paragraph(
      `${sent.length} posts, retrieved by ${method === "hybrid" ? "keywords and meaning" : method === "semantic" ? "meaning only" : "keywords only"}. Ordinary feed exposures are excluded.`,
    ),
  );
  target.append(
    paragraph(
      "Cosine similarity ranges from −1 to 1; higher means more similar, not a shorter distance or a probability of shared beliefs. Semantic matches rank first by cosine; keyword-only matches follow. The LLM assesses stance separately.",
    ),
  );
  for (const [index, post] of sent.entries()) {
    const details = document.createElement("details");
    details.dataset.section = `post-${post.key}`;
    const label = document.createElement("summary");
    label.textContent = `${index + 1}. @${post.author} · ${post.basis}`;
    details.append(label, paragraph(post.text));
    const retrieved = trace.retrieved.find((p) => p.key === post.key);
    const terms = retrieved?.matchedTerms ?? [];
    details.append(
      paragraph(`Retrieval source: ${retrieved?.retrievalMethod ?? "lexical"}`),
    );
    details.append(paragraph(`Matching terms: ${terms.join(", ") || "—"}`));
    const score = retrieved?.similarity;
    const scoreLabel =
      score === undefined
        ? trace.embedding?.ok
          ? "— (not indexed with the current encoder)"
          : "— (semantic scoring unavailable)"
        : score.toFixed(3) +
          (retrieved?.retrievalMethod === "lexical"
            ? " (below semantic cutoff; selected by keywords)"
            : "");
    details.append(paragraph(`Cosine similarity: ${scoreLabel}`));
    const url = safePostLink(post.url);
    if (url) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open original post";
      details.append(a);
    }
    target.append(details);
  }
  if (trace.request)
    target.append(
      section(
        "Exact prompt and context sent",
        JSON.stringify(trace.request, null, 2),
        "request",
      ),
    );
  if (trace.findings.length)
    target.append(
      section(
        "Accepted findings",
        JSON.stringify(trace.findings, null, 2),
        "findings",
      ),
    );
  if (trace.validation.length)
    target.append(
      section("Validation details", trace.validation.join("\n"), "validation"),
    );
  trace.responses.forEach((response, i) =>
    target.append(
      section(
        `Model response ${i + 1}${response.truncated ? " (truncated to 50,000 characters)" : ""}`,
        response.text,
        `response-${i}`,
      ),
    ),
  );
  for (const details of Array.from(
    target.querySelectorAll<HTMLDetailsElement>("details"),
  ))
    details.open = opened.has(details.dataset.section);
}

/** A full-size, dismissible view; no new tab, persistent storage or extra sidebar cards. */
export function initializeConfirmationDiagnosticsView(
  store: ConfirmationDiagnostics = confirmationDiagnostics,
): void {
  const trigger = document.getElementById("confirmation-diagnostics");
  if (!trigger) return;
  const dialog = document.createElement("dialog");
  dialog.className = "cb-diagnostics";
  dialog.setAttribute("aria-labelledby", "cb-diagnostics-title");
  const header = document.createElement("header");
  const heading = document.createElement("h1");
  heading.id = "cb-diagnostics-title";
  heading.textContent = "CB diagnostics";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => dialog.close());
  header.append(heading, close);
  const privacy = paragraph(
    "Latest check only. Kept in this sidebar's memory, cleared when it unloads or activity settings change. Exports include post text; no API keys or request headers are recorded.",
  );
  const actions = document.createElement("div");
  actions.className = "cb-diagnostics-actions";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Export JSON";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear trace";
  clear.addEventListener("click", () => store.clear());
  const content = document.createElement("div");
  actions.append(exportButton, clear);
  dialog.append(header, privacy, actions, content);
  document.body.append(dialog);
  const render = () => {
    if (!dialog.open) return;
    const top = dialog.scrollTop;
    renderConfirmationTrace(content, store.get());
    exportButton.disabled = !store.get();
    clear.disabled = !store.get();
    dialog.scrollTop = top;
  };
  store.subscribe(render);
  window.addEventListener("pagehide", () => store.clear());
  trigger.addEventListener("click", () => {
    dialog.showModal();
    render();
  });
  exportButton.addEventListener("click", () => {
    const trace = store.get();
    if (!trace) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `vigil-cb-diagnostics-${trace.startedAt}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
