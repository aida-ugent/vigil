import "./styles.css";
import {
  DEFAULT_SETTINGS,
  type VigilSettings,
} from "../shared/settings";
import {
  getSettings,
  subscribeSettings,
} from "../shared/settingsStorage";
import {
  isRuntimeEventMessage,
  sendRuntimeMessage,
} from "../shared/messages";
import { formatFindingMeta, findingMetaDetails, type Finding } from "../shared/findings";
import type {
  ContentAnalysisResult,
  ContentItem,
  ContentPlatform,
  VisibleContentUpdate,
} from "../shared/content";
import { cacheManager } from "../shared/cacheManager";
import { resolveLLMService } from "../llm/service";
import type { LLMService } from "../llm/types";
import { browserPluginRegistry } from "../plugins/registry";
import { SIMPLE_REPLACEMENTS } from "../plugins/cognitiveBiasTrigger/config";
import {
  analyzeSingleItem as runAnalysis,
  deriveAnalyzerMode,
  getActivePluginIds,
  findReformulationPlugin,
} from "./analysisService";
import { createSettingsController } from "./settingsController";

// ── DOM references (analyze tab only) ──

const saveStatus = document.getElementById("save-status");
const panelStatusBanner = document.getElementById("panel-status-banner");
const analyzeTabButton = document.getElementById("panel-tab-analyze");
const settingsTabButton = document.getElementById("panel-tab-settings");
const analyzeTabContent = document.getElementById("panel-content-analyze");
const settingsTabContent = document.getElementById("panel-content-settings");
const runtimeConnection = document.getElementById("runtime-connection");
const runtimeTab = document.getElementById("runtime-tab");
const runtimeContent = document.getElementById("runtime-content");
const contentAnalysisList = document.getElementById("content-analysis-list");
const highlightStatus = document.getElementById("highlight-status");
const diagMode = document.getElementById("diag-mode");
const diagBackend = document.getElementById("diag-backend");
const diagModel = document.getElementById("diag-model");
const diagPlatform = document.getElementById("diag-platform");

const viewingCard = document.getElementById("viewing-card");
const viewingPlaceholder = document.getElementById("viewing-placeholder");
const viewingAuthor = document.getElementById("viewing-author");
const viewingText = document.getElementById("viewing-text");
const viewingFindings = document.getElementById("viewing-findings");
const viewingNotAnalyzed = document.getElementById("viewing-not-analyzed");
const viewingAnalyzed = document.getElementById("viewing-analyzed");
const viewingDot = document.getElementById("viewing-dot");
const viewingFindingsCount = document.getElementById("viewing-findings-count");
const viewingCacheBadge = document.getElementById("viewing-cache-badge");
const analyzeCurrentBtn = document.getElementById("analyze-current-btn");
const rewriteCurrentBtn = document.getElementById("rewrite-current-btn");
const alternativesCurrentBtn = document.getElementById("alternatives-current-btn");
const deleteCurrentBtn = document.getElementById("delete-current-btn");
const alternativesResultEl = document.getElementById("alternatives-result");
const alternativesListEl = document.getElementById("alternatives-list");
const dismissAlternativesBtn = document.getElementById("dismiss-alternatives-btn");
const cacheStatsEl = document.getElementById("cache-stats");
const clearCacheBtn = document.getElementById("clear-cache-btn");
const exportCacheBtn = document.getElementById("export-cache-btn");

// ── State ──

let currentSettings: VigilSettings = DEFAULT_SETTINGS;
let currentLLM: LLMService = resolveLLMService(DEFAULT_SETTINGS);

let contentAnalysisResults: ContentAnalysisResult[] = [];
let highlightsActive = false;
let currentPlatform: ContentPlatform = "generic";
let currentPageUrl = "";
let currentPageTitle = "";

let currentViewingItem: ContentItem | null = null;
const analyzingIds = new Set<string>();
const reformulatedIds = new Set<string>();

type PanelTab = "analyze" | "settings";

// ── Settings controller ──

const settingsCtrl = createSettingsController({
  onSaveStatus: setSaveStatus,
  onPanelStatus: setPanelStatus,
  onDiagnosticsChanged: updateDiagnostics,
  getCurrentSettings: () => currentSettings,
  setCurrentSettings: (s) => { currentSettings = s; },
});

// ── Helpers ──

function setSaveStatus(message: string, state: "idle" | "saved" | "error"): void {
  if (!saveStatus) return;
  saveStatus.textContent = message;
  saveStatus.setAttribute("data-state", state);
}

function setPanelStatus(
  message: string,
  tone: "neutral" | "success" | "warning" | "error" = "neutral",
): void {
  if (!panelStatusBanner) return;
  panelStatusBanner.textContent = message;
  panelStatusBanner.setAttribute("data-tone", tone);
}

function updateDiagnostics(): void {
  if (diagMode) diagMode.textContent = deriveAnalyzerMode(currentSettings);
  if (diagBackend) diagBackend.textContent = currentSettings.llmBackend;
  if (diagPlatform) diagPlatform.textContent = currentPlatform;
  if (diagModel) {
    const webLLM = settingsCtrl.getWebLLMService();
    if (currentSettings.llmBackend !== "webllm") {
      diagModel.textContent = currentSettings.llmBackend === "none" ? "—" : currentSettings.cloudModelId || currentSettings.localModelId || "—";
      return;
    }
    const status = webLLM.getStatus();
    if (status === "ready") diagModel.textContent = `${currentSettings.webllmModelId} (ready)`;
    else if (status === "loading") diagModel.textContent = `${currentSettings.webllmModelId} (loading)`;
    else if (status === "error") diagModel.textContent = `${currentSettings.webllmModelId} (error)`;
    else diagModel.textContent = "Not loaded";
  }
}

async function updateCacheStats(): Promise<void> {
  try {
    const stats = await cacheManager.getStats(currentPageUrl || undefined);
    if (cacheStatsEl) cacheStatsEl.textContent = `${stats.totalEntries} cached · ${stats.entriesForPage} on page`;
  } catch {
    if (cacheStatsEl) cacheStatsEl.textContent = "—";
  }
}

function setActivePanelTab(tab: PanelTab): void {
  const analyzeActive = tab === "analyze";
  if (analyzeTabButton) analyzeTabButton.setAttribute("data-active", String(analyzeActive));
  if (settingsTabButton) settingsTabButton.setAttribute("data-active", String(!analyzeActive));
  if (analyzeTabContent) analyzeTabContent.classList.toggle("panel-tab-content-hidden", !analyzeActive);
  if (settingsTabContent) settingsTabContent.classList.toggle("panel-tab-content-hidden", analyzeActive);
}

function setConnectionState(state: "connecting" | "connected" | "disconnected"): void {
  if (runtimeConnection) {
    runtimeConnection.textContent = state === "connecting" ? "Connecting..." : state === "connected" ? "Connected" : "Unavailable";
  }
  if (state === "disconnected") setPanelStatus("Runtime unavailable. Refresh page.", "warning");
}

function setRuntimeTab(url: string | null): void {
  if (!runtimeTab) return;
  if (!url) { runtimeTab.textContent = "Unknown"; return; }
  try {
    const parsed = new URL(url);
    const compact = `${parsed.hostname}${parsed.pathname}`;
    runtimeTab.textContent = compact.length > 40 ? `${compact.slice(0, 40)}...` : compact;
  } catch {
    runtimeTab.textContent = url.length > 40 ? `${url.slice(0, 40)}...` : url;
  }
}

function setContentReady(isReady: boolean): void {
  if (runtimeContent) runtimeContent.textContent = isReady ? "Ready" : "Waiting...";
}

function clearElementChildren(node: Element | null): void {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function severityClassName(severity: Finding["severity"]): string {
  if (severity === "high") return "severity-high";
  if (severity === "medium") return "severity-medium";
  return "severity-low";
}

function getGenericSourceLabel(): string {
  const title = currentPageTitle.trim();
  if (title.length > 0) {
    return title.length > 52 ? `${title.slice(0, 52)}...` : title;
  }
  try {
    const host = new URL(currentPageUrl).hostname.replace(/^www\./, "");
    return host || "Article";
  } catch {
    return "Article";
  }
}

// ── Currently Viewing ──

function showViewingPlaceholder(): void {
  if (viewingPlaceholder) viewingPlaceholder.style.display = "";
  if (viewingAuthor) viewingAuthor.style.display = "none";
  if (viewingText) viewingText.style.display = "none";
  if (viewingNotAnalyzed) viewingNotAnalyzed.style.display = "none";
  if (viewingAnalyzed) viewingAnalyzed.style.display = "none";
}

function handleVisibilityChange(update: VisibleContentUpdate): void {
  if (!update.primaryId || !update.primaryText) {
    currentViewingItem = null;
    currentPageTitle = "";
    showViewingPlaceholder();
    return;
  }

  currentPlatform = update.platform;
  currentPageUrl = update.pageUrl;
  currentPageTitle = update.pageTitle ?? "";

  currentViewingItem = {
    id: update.primaryId,
    text: update.primaryText,
    platform: update.platform,
    pageUrl: update.pageUrl,
    author: update.primaryAuthor ?? undefined,
  };

  renderViewingCard();

  const alreadyAnalyzed = contentAnalysisResults.some((r) => r.id === update.primaryId);
  if (currentSettings.autoAnalyze && !alreadyAnalyzed && !analyzingIds.has(update.primaryId)) {
    void analyzeSingleItem(currentViewingItem);
  }
}

function renderViewingCard(): void {
  if (!viewingCard || !currentViewingItem) return;

  if (viewingPlaceholder) viewingPlaceholder.style.display = "none";
  if (viewingAuthor) viewingAuthor.style.display = "";
  if (viewingText) viewingText.style.display = "";

  if (viewingAuthor) {
    if (currentViewingItem.author) {
      viewingAuthor.textContent = `@${currentViewingItem.author}`;
    } else if (currentViewingItem.platform === "generic") {
      viewingAuthor.textContent = getGenericSourceLabel();
    } else {
      viewingAuthor.textContent = currentViewingItem.platform;
    }
  }

  if (viewingText) {
    const text = currentViewingItem.text;
    viewingText.textContent = text.length > 200 ? text.slice(0, 200) + "..." : text;
  }

  const result = contentAnalysisResults.find((r) => r.id === currentViewingItem!.id);
  clearElementChildren(viewingFindings);
  hideAlternativesResult();

  if (reformulatedIds.has(currentViewingItem.id)) {
    showRestoreButton();
  } else {
    hideRestoreButton();
  }

  if (result) {
    if (viewingNotAnalyzed) viewingNotAnalyzed.style.display = "none";
    if (viewingAnalyzed) viewingAnalyzed.style.display = "";

    const count = result.findings.length;
    const hasFindings = count > 0;

    if (viewingDot) viewingDot.className = `viewing-dot ${hasFindings ? "viewing-dot--amber" : "viewing-dot--green"}`;
    if (viewingFindingsCount) viewingFindingsCount.textContent = hasFindings ? `${count} finding${count !== 1 ? "s" : ""}` : "No triggers found";
    if (viewingCacheBadge) viewingCacheBadge.style.display = result.cached ? "" : "none";

    for (let i = 0; i < result.findings.length; i++) {
      const f = result.findings[i];
      const row = document.createElement("div");
      row.className = "viewing-finding-mini";
      row.setAttribute("data-expanded", "false");

      const topLine = document.createElement("div"); topLine.className = "finding-row finding-row--clickable";
      const term = document.createElement("span"); term.className = "finding-term"; term.textContent = f.term;
      const label = document.createElement("span"); label.className = "finding-label"; label.textContent = f.label;
      const badge = document.createElement("span"); badge.className = `severity-badge ${severityClassName(f.severity)}`; badge.textContent = f.severity;
      topLine.appendChild(term); topLine.appendChild(label); topLine.appendChild(badge);
      row.appendChild(topLine);

      const detail = document.createElement("div"); detail.className = "viewing-finding-detail";
      const explanation = document.createElement("p"); explanation.className = "finding-explanation"; explanation.textContent = f.explanation;
      detail.appendChild(explanation);

      const metaRows = findingMetaDetails(f);
      if (metaRows.length > 0) {
        const metaGrid = document.createElement("div"); metaGrid.className = "finding-meta-grid";
        for (const { label: metaLabel, value } of metaRows) {
          const lbl = document.createElement("span"); lbl.className = "finding-meta-label"; lbl.textContent = metaLabel;
          const val = document.createElement("span"); val.className = "finding-meta-value"; val.textContent = value;
          metaGrid.appendChild(lbl); metaGrid.appendChild(val);
        }
        detail.appendChild(metaGrid);
      }

      row.appendChild(detail);

      topLine.addEventListener("click", () => {
        const expanded = row.getAttribute("data-expanded") === "true";
        row.setAttribute("data-expanded", String(!expanded));
      });

      viewingFindings?.appendChild(row);
    }
  } else {
    if (viewingNotAnalyzed) viewingNotAnalyzed.style.display = "";
    if (viewingAnalyzed) viewingAnalyzed.style.display = "none";
    if (viewingCacheBadge) viewingCacheBadge.style.display = "none";
  }

  highlightCurrentlyViewedResult(currentViewingItem.id);
  updateRewriteButtonState();
}

function highlightCurrentlyViewedResult(primaryId: string | null): void {
  const items = contentAnalysisList ? Array.from(contentAnalysisList.querySelectorAll(".content-analysis-item")) : [];
  for (const item of items) {
    const isViewing = item.getAttribute("data-content-id") === primaryId;
    item.setAttribute("data-viewing", String(isViewing));
    if (isViewing) item.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ── Default action dispatch ──

async function runDefaultAction(contentId: string): Promise<void> {
  switch (currentSettings.defaultAction) {
    case "rewrite":
      await handleRewrite(contentId);
      break;
    case "alternatives":
      await handleAlternatives(contentId);
      break;
    case "delete":
      await handleDelete(contentId);
      break;
  }
}

// ── Single-item analysis ──

async function analyzeSingleItem(item: ContentItem, forceRefresh = false): Promise<void> {
  if (analyzingIds.has(item.id)) return;

  const activePluginIds = getActivePluginIds(currentSettings);
  if (activePluginIds.length === 0) {
    setPanelStatus("No plugins selected. Enable at least one plugin in Settings.", "error");
    return;
  }

  // When auto-analyze is on with an action intent (rewrite/delete),
  // obscure the content immediately so the user doesn't see triggering
  // text while the LLM is working.
  const willAutoAct = currentSettings.autoAnalyze && currentSettings.defaultAction !== "none" && currentSettings.defaultAction !== "alternatives";
  if (willAutoAct) {
    void sendRuntimeMessage({ type: "OBSCURE_CONTENT_REQUEST", payload: { contentId: item.id } });
  }

  analyzingIds.add(item.id);
  if (analyzeCurrentBtn instanceof HTMLButtonElement) {
    analyzeCurrentBtn.innerHTML = SPINNER_HTML + " Analyzing\u2026";
    analyzeCurrentBtn.disabled = true;
  }
  setPanelStatus("Analyzing...", "neutral");

  try {
    const { result: newResult, pipelineInfo } = await runAnalysis(item, currentSettings, { forceRefresh });
    upsertResult(newResult);
    renderContentAnalysisResults(contentAnalysisResults);
    await sendContentHighlights(contentAnalysisResults);
    renderViewingCard();

    if (newResult.cached) {
      setPanelStatus(`${newResult.findings.length} findings (cached).`, newResult.findings.length > 0 ? "success" : "neutral");
    } else {
      const summary = `${newResult.findings.length} findings [${pipelineInfo.analyzersUsed}] · ${newResult.elapsedMs} ms`;
      setPanelStatus(pipelineInfo.warning ? `${summary} — ${pipelineInfo.warning}` : summary, newResult.findings.length > 0 ? "success" : "neutral");
    }

    if (newResult.findings.length > 0) {
      void sendRuntimeMessage({ type: "MARK_ANALYZED_REQUEST", payload: { contentId: item.id, count: newResult.findings.length } });
      if (currentSettings.defaultAction !== "none") void runDefaultAction(item.id);
    } else {
      // Clean content — reveal it (remove blur)
      if (willAutoAct) void sendRuntimeMessage({ type: "REVEAL_CONTENT_REQUEST", payload: { contentId: item.id } });
      void sendRuntimeMessage({ type: "MARK_VERIFIED_REQUEST", payload: { contentId: item.id } });
    }
  } catch (error) {
    console.error("[Vigil v2] Analysis failed", { id: item.id, error });
    // Analysis failed — reveal so user isn't stuck with blurred content
    if (willAutoAct) void sendRuntimeMessage({ type: "REVEAL_CONTENT_REQUEST", payload: { contentId: item.id } });
    setPanelStatus("Analysis failed.", "error");
  } finally {
    analyzingIds.delete(item.id);
    if (analyzeCurrentBtn instanceof HTMLButtonElement) {
      analyzeCurrentBtn.innerHTML = ANALYZE_SVG + " Analyze";
      analyzeCurrentBtn.disabled = false;
    }
    void updateCacheStats();
  }
}

function upsertResult(result: ContentAnalysisResult): void {
  const idx = contentAnalysisResults.findIndex((r) => r.id === result.id);
  if (idx >= 0) contentAnalysisResults[idx] = result;
  else contentAnalysisResults.push(result);
}

// ── Results rendering ──

function createFindingNode(finding: Finding, contentId: string, findingIndex: number): HTMLElement {
  const card = document.createElement("article"); card.className = "finding-item";
  const row = document.createElement("div"); row.className = "finding-row";
  const term = document.createElement("span"); term.className = "finding-term"; term.textContent = finding.term;
  const label = document.createElement("span"); label.className = "finding-label"; label.textContent = finding.label;
  const severity = document.createElement("span"); severity.className = `severity-badge ${severityClassName(finding.severity)}`; severity.textContent = finding.severity;
  row.appendChild(term); row.appendChild(label); row.appendChild(severity);
  const explanation = document.createElement("p"); explanation.className = "finding-explanation"; explanation.textContent = finding.explanation;
  card.appendChild(row); card.appendChild(explanation);

  const metaRows = findingMetaDetails(finding);
  if (metaRows.length > 0) {
    const metaGrid = document.createElement("div"); metaGrid.className = "finding-meta-grid";
    for (const { label: metaLabel, value } of metaRows) {
      const lbl = document.createElement("span"); lbl.className = "finding-meta-label"; lbl.textContent = metaLabel;
      const val = document.createElement("span"); val.className = "finding-meta-value"; val.textContent = value;
      metaGrid.appendChild(lbl); metaGrid.appendChild(val);
    }
    card.appendChild(metaGrid);
  }

  return card;
}

function renderContentAnalysisResults(results: ContentAnalysisResult[]): void {
  clearElementChildren(contentAnalysisList);
  if (!contentAnalysisList || results.length === 0) return;

  for (const result of results) {
    const card = document.createElement("article"); card.className = "content-analysis-item"; card.setAttribute("data-content-id", result.id);
    if (currentViewingItem && result.id === currentViewingItem.id) card.setAttribute("data-viewing", "true");
    card.setAttribute("data-collapsed", "true");

    const top = document.createElement("div"); top.className = "content-analysis-top";
    const headerLeft = document.createElement("div"); headerLeft.className = "content-analysis-header";
    const meta = document.createElement("span"); meta.className = "content-analysis-meta";
    meta.textContent = `${result.findings.length} finding${result.findings.length !== 1 ? "s" : ""} · ${result.elapsedMs} ms${result.cached ? " · cached" : ""}`;
    headerLeft.appendChild(meta);

    const actions = document.createElement("div"); actions.className = "content-analysis-actions";
    const removeBtn = document.createElement("button"); removeBtn.className = "btn-icon btn-danger"; removeBtn.textContent = "✕"; removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => void removeContentResult(result.id));

    if (result.findings.length > 0) {
      const collapseBtn = document.createElement("button"); collapseBtn.className = "btn-icon"; collapseBtn.textContent = "▸"; collapseBtn.title = "Toggle findings";
      collapseBtn.addEventListener("click", () => {
        const collapsed = card.getAttribute("data-collapsed") === "true";
        card.setAttribute("data-collapsed", String(!collapsed));
        collapseBtn.textContent = collapsed ? "▾" : "▸";
      });
      actions.appendChild(collapseBtn);
    }
    actions.appendChild(removeBtn);
    top.appendChild(headerLeft); top.appendChild(actions);

    const findingsWrap = document.createElement("div"); findingsWrap.className = "content-analysis-findings";
    result.findings.forEach((f, idx) => findingsWrap.appendChild(createFindingNode(f, result.id, idx)));

    card.appendChild(top);
    if (result.findings.length > 0) card.appendChild(findingsWrap);
    contentAnalysisList.appendChild(card);
  }
}

function clearContentAnalysis(): void { contentAnalysisResults = []; renderContentAnalysisResults([]); }

async function removeFinding(contentId: string, findingIndex: number): Promise<void> {
  const result = contentAnalysisResults.find((r) => r.id === contentId);
  if (!result) return;
  result.findings.splice(findingIndex, 1);
  await cacheManager.removeFinding(contentId, findingIndex);
  renderContentAnalysisResults(contentAnalysisResults);
  await sendContentHighlights(contentAnalysisResults);
  renderViewingCard();
  void updateCacheStats();
}

async function removeContentResult(contentId: string): Promise<void> {
  contentAnalysisResults = contentAnalysisResults.filter((r) => r.id !== contentId);
  await cacheManager.remove(contentId);
  renderContentAnalysisResults(contentAnalysisResults);
  await sendContentHighlights(contentAnalysisResults);
  renderViewingCard();
  void updateCacheStats();
}

// ── Highlights ──

function setHighlightStatus(message: string, active: boolean): void {
  if (highlightStatus) highlightStatus.textContent = message || "—";
  highlightsActive = active;
}

async function sendContentHighlights(results: ContentAnalysisResult[]): Promise<void> {
  const withFindings = results.filter((r) => r.findings.length > 0);
  if (withFindings.length === 0) { setHighlightStatus("", false); return; }

  try {
    const response = await sendRuntimeMessage({ type: "HIGHLIGHT_FINDINGS_REQUEST", payload: { results: withFindings } });
    if (response.type === "HIGHLIGHT_RESULT") {
      const { highlightedItems, totalHighlights } = response.payload;
      setHighlightStatus(totalHighlights > 0 ? `${totalHighlights} highlights in ${highlightedItems} items` : "No highlights applied", totalHighlights > 0);
    }
  } catch (error) {
    console.error("[Vigil v2] Highlight request failed", error);
    setHighlightStatus("Highlight failed", false);
  }
}

// ── Action handlers ──

function setActionButtonsLoading(loading: boolean): void {
  for (const btn of [rewriteCurrentBtn, alternativesCurrentBtn, deleteCurrentBtn]) {
    if (btn instanceof HTMLButtonElement) btn.disabled = loading;
  }
}

async function handleRewrite(contentId: string): Promise<void> {
  if (!currentViewingItem) return;
  const analysisResult = contentAnalysisResults.find((r) => r.id === contentId);
  if (!analysisResult || analysisResult.findings.length === 0) { setPanelStatus("No findings to reformulate.", "warning"); return; }

  const pluginId = findReformulationPlugin(analysisResult.findings);
  if (!pluginId) { setPanelStatus("No reformulation-capable plugin available.", "warning"); return; }
  if (!currentLLM.isAvailable()) {
    setPanelStatus(`LLM required for rewriting. ${currentSettings.llmBackend === "webllm" ? "Load a Browser AI model first." : "Check your LLM backend configuration."}`, "warning");
    return;
  }

  setActionButtonsLoading(true);
  if (rewriteCurrentBtn instanceof HTMLButtonElement) rewriteCurrentBtn.innerHTML = SPINNER_HTML + " Rewriting\u2026";
  setPanelStatus("Rewriting...", "neutral");
  try {
    const ctx = { settings: currentSettings, llm: currentLLM };
    const result = await browserPluginRegistry.reformulateWith(pluginId, currentViewingItem.text, analysisResult.findings, ctx);
    if (!result || !result.reformulatedText) { setPanelStatus("Reformulation produced no result.", "warning"); return; }
    void sendRuntimeMessage({ type: "REVEAL_CONTENT_REQUEST", payload: { contentId } });
    const resp = await sendRuntimeMessage({ type: "APPLY_REFORMULATION_REQUEST", payload: { contentId, reformulatedText: result.reformulatedText } });
    if (resp.payload.ok) { reformulatedIds.add(contentId); showRestoreButton(); setPanelStatus("Rewrite applied.", "success"); }
    else setPanelStatus("Could not apply — element not found on page.", "warning");
  } catch (error) {
    console.error("[Vigil v2] Rewrite failed", error);
    setPanelStatus(`Rewrite failed: ${error instanceof Error ? error.message : "unknown error"}`, "error");
  } finally {
    setActionButtonsLoading(false);
    if (rewriteCurrentBtn instanceof HTMLButtonElement && rewriteCurrentBtn.dataset.mode !== "restore") {
      rewriteCurrentBtn.innerHTML = REWRITE_SVG + " Rewrite";
    }
  }
}

async function handleAlternatives(contentId: string): Promise<void> {
  const analysisResult = contentAnalysisResults.find((r) => r.id === contentId);
  if (!analysisResult || analysisResult.findings.length === 0) { setPanelStatus("No findings to generate alternatives for.", "warning"); return; }

  const alternatives: Array<{ original: string; suggestion: string }> = [];
  const seen = new Set<string>();
  for (const f of analysisResult.findings) {
    if (!f.term) continue;
    const key = f.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const replacement = SIMPLE_REPLACEMENTS[key];
    alternatives.push({ original: f.term, suggestion: replacement ?? `Consider: ${f.explanation || "Use neutral language"}` });
  }

  if (alternatives.length === 0) { setPanelStatus("No alternatives available.", "neutral"); return; }
  showAlternativesResult(alternatives);
  setPanelStatus(`${alternatives.length} alternative${alternatives.length !== 1 ? "s" : ""} found.`, "success");
}

function showAlternativesResult(alternatives: Array<{ original: string; suggestion: string }>): void {
  const actionBtns = document.getElementById("viewing-action-buttons");
  if (actionBtns) actionBtns.style.display = "none";
  if (alternativesResultEl) {
    const ul = document.createElement("ul");
    for (const alt of alternatives) {
      const li = document.createElement("li");
      const orig = document.createElement("strong"); orig.textContent = alt.original;
      li.appendChild(orig); li.appendChild(document.createTextNode(" → ")); li.appendChild(document.createTextNode(alt.suggestion));
      ul.appendChild(li);
    }
    if (alternativesListEl) alternativesListEl.replaceChildren(ul);
    alternativesResultEl.style.display = "";
  }
}

function hideAlternativesResult(): void {
  if (alternativesResultEl) alternativesResultEl.style.display = "none";
  const actionBtns = document.getElementById("viewing-action-buttons");
  if (actionBtns) actionBtns.style.display = "";
}

async function handleDelete(contentId: string): Promise<void> {
  if (!currentViewingItem) return;
  setActionButtonsLoading(true);
  setPanelStatus("Hiding content...", "neutral");
  try {
    void sendRuntimeMessage({ type: "REVEAL_CONTENT_REQUEST", payload: { contentId } });
    const resp = await sendRuntimeMessage({ type: "HIDE_CONTENT_REQUEST", payload: { contentId, text: currentViewingItem.text } });
    if (resp.payload.ok) { reformulatedIds.add(contentId); setPanelStatus("Content hidden on page.", "success"); showRestoreButton(); }
    else setPanelStatus("Could not hide — element not found.", "warning");
  } catch (error) {
    console.error("[Vigil v2] Delete failed", error);
    setPanelStatus("Hide failed.", "error");
  } finally { setActionButtonsLoading(false); }
}

async function handleRestore(contentId: string): Promise<void> {
  if (rewriteCurrentBtn instanceof HTMLButtonElement) rewriteCurrentBtn.disabled = true;
  setPanelStatus("Restoring...", "neutral");
  try {
    const reformResp = await sendRuntimeMessage({ type: "RESTORE_ORIGINAL_REQUEST", payload: { contentId } });
    if (!reformResp.payload.ok) await sendRuntimeMessage({ type: "UNHIDE_CONTENT_REQUEST", payload: { contentId } });
    reformulatedIds.delete(contentId);
    hideRestoreButton();
    updateRewriteButtonState();

    const analysisResult = contentAnalysisResults.find((r) => r.id === contentId);
    if (analysisResult && analysisResult.findings.length > 0) {
      void sendRuntimeMessage({ type: "MARK_ANALYZED_REQUEST", payload: { contentId, count: analysisResult.findings.length } });
    }

    setPanelStatus("Restored to original.", "success");
  } catch (error) {
    console.error("[Vigil v2] Restore failed", error);
    setPanelStatus("Restore failed.", "error");
  } finally { if (rewriteCurrentBtn instanceof HTMLButtonElement) rewriteCurrentBtn.disabled = false; }
}

const ANALYZE_SVG = '<svg class="btn-icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>';
const SPINNER_HTML = '<span class="spinner"></span>';
const REWRITE_SVG = '<svg class="btn-icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
const RESTORE_SVG = '<svg class="btn-icon-svg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>';

function showRestoreButton(): void {
  if (!(rewriteCurrentBtn instanceof HTMLButtonElement)) return;
  rewriteCurrentBtn.innerHTML = RESTORE_SVG + " Restore Original";
  rewriteCurrentBtn.className = "btn btn-sm btn-ghost";
  rewriteCurrentBtn.dataset.mode = "restore";
  rewriteCurrentBtn.disabled = false;
  rewriteCurrentBtn.title = "";
}

function hideRestoreButton(): void {
  if (!(rewriteCurrentBtn instanceof HTMLButtonElement)) return;
  rewriteCurrentBtn.innerHTML = REWRITE_SVG + " Rewrite";
  rewriteCurrentBtn.className = "btn btn-sm btn-rewrite";
  delete rewriteCurrentBtn.dataset.mode;
}

function updateRewriteButtonState(): void {
  if (!(rewriteCurrentBtn instanceof HTMLButtonElement)) return;
  const analysisResult = currentViewingItem ? contentAnalysisResults.find((r) => r.id === currentViewingItem!.id) : null;
  if (!analysisResult || analysisResult.findings.length === 0) { rewriteCurrentBtn.disabled = true; rewriteCurrentBtn.title = "Analyze content first"; return; }
  const pluginId = findReformulationPlugin(analysisResult.findings);
  if (!pluginId) { rewriteCurrentBtn.disabled = true; rewriteCurrentBtn.title = "No reformulation-capable plugin (requires LLM analysis)"; return; }
  if (!currentLLM.isAvailable()) { rewriteCurrentBtn.disabled = true; rewriteCurrentBtn.title = currentSettings.llmBackend === "webllm" ? "Load a Browser AI model to enable rewriting" : "LLM backend unavailable"; return; }
  rewriteCurrentBtn.disabled = false;
  rewriteCurrentBtn.title = "Rewrite to neutralize bias triggers";
}

// ── Runtime connection ──

function clearTransientState(): void {
  setContentReady(false);
  clearContentAnalysis();
  setHighlightStatus("", false);
  currentViewingItem = null;
  currentPageTitle = "";
  showViewingPlaceholder();
  setPanelStatus("Page changed. Scroll to analyze.", "warning");
}

async function probeContentScript(tabId: number | null): Promise<void> {
  if (tabId === null) { setContentReady(false); return; }
  try {
    const tabResponse = await chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" });
    const ready = tabResponse?.type === "CONTENT_PONG";
    setContentReady(ready);
    if (ready) {
      // Content script is alive — ask it to re-emit what's currently visible
      // so the "Currently Viewing" card populates immediately.
      chrome.tabs.sendMessage(tabId, { type: "REQUEST_VISIBLE_CONTENT" }).catch(() => {});
    }
  } catch { setContentReady(false); }
}

async function initializeRuntimeConnection(): Promise<void> {
  setConnectionState("connecting");
  try {
    await sendRuntimeMessage({ type: "PING" });
    setConnectionState("connected");
    const activeTab = await sendRuntimeMessage({ type: "GET_ACTIVE_TAB" });
    setRuntimeTab(activeTab.payload.url);
    currentPageUrl = activeTab.payload.url ?? "";
    await probeContentScript(activeTab.payload.tabId);
  } catch (error) {
    console.error("[Vigil v2] Runtime handshake failed", error);
    setConnectionState("disconnected");
    setRuntimeTab(null);
    setContentReady(false);
  }
}

// ── Event bindings ──

function bindRuntimeEvents(): void {
  chrome.runtime.onMessage.addListener((message) => {
    if (!isRuntimeEventMessage(message)) return;
    if (message.type === "TAB_NAVIGATED") {
      setConnectionState("connected");
      setRuntimeTab(message.payload.url);
      currentPageUrl = message.payload.url;
      clearTransientState();
      void probeContentScript(message.payload.tabId);
    }
    if (message.type === "VISIBLE_CONTENT_CHANGED") handleVisibilityChange(message.payload);
  });
}

function bindAnalyzeActions(): void {
  if (analyzeCurrentBtn instanceof HTMLButtonElement) {
    analyzeCurrentBtn.addEventListener("click", () => {
      if (!currentViewingItem) return;
      void analyzeSingleItem(currentViewingItem, contentAnalysisResults.some((r) => r.id === currentViewingItem!.id));
    });
  }
  if (rewriteCurrentBtn instanceof HTMLButtonElement) {
    rewriteCurrentBtn.addEventListener("click", () => {
      if (!currentViewingItem) return;
      if (rewriteCurrentBtn.dataset.mode === "restore") void handleRestore(currentViewingItem.id);
      else void handleRewrite(currentViewingItem.id);
    });
  }
  if (alternativesCurrentBtn instanceof HTMLButtonElement) alternativesCurrentBtn.addEventListener("click", () => { if (currentViewingItem) void handleAlternatives(currentViewingItem.id); });
  if (deleteCurrentBtn instanceof HTMLButtonElement) deleteCurrentBtn.addEventListener("click", () => { if (currentViewingItem) void handleDelete(currentViewingItem.id); });
  if (dismissAlternativesBtn instanceof HTMLButtonElement) dismissAlternativesBtn.addEventListener("click", () => hideAlternativesResult());
  if (exportCacheBtn instanceof HTMLButtonElement) {
    exportCacheBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => {
        const entries = await cacheManager.getAll();
        const json = JSON.stringify({
          version: 1,
          source: "vigil_analysis_cache",
          exportedAt: new Date().toISOString(),
          count: entries.length,
          entries,
        }, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `vigil-cache-export-${ts}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setPanelStatus(`Exported ${entries.length} entries.`, "neutral");
      })();
    });
  }
  if (clearCacheBtn instanceof HTMLButtonElement) {
    clearCacheBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void (async () => { await cacheManager.clear(); clearElementChildren(contentAnalysisList); void updateCacheStats(); setPanelStatus("Cache cleared.", "neutral"); })();
    });
  }
}

// ── Render on settings change ──

function render(settings: VigilSettings): void {
  currentSettings = settings;
  currentLLM = resolveLLMService(settings);
  settingsCtrl.render(settings);
  updateDiagnostics();
}

// ── Init ──

async function init(): Promise<void> {
  if (analyzeTabButton instanceof HTMLButtonElement)
    analyzeTabButton.addEventListener("click", () => setActivePanelTab("analyze"));
  if (settingsTabButton instanceof HTMLButtonElement)
    settingsTabButton.addEventListener("click", () => setActivePanelTab("settings"));
  setActivePanelTab("analyze");
  setPanelStatus("Initializing...", "neutral");

  bindRuntimeEvents();
  bindAnalyzeActions();
  settingsCtrl.bind();
  await initializeRuntimeConnection();

  try {
    const settings = await getSettings();
    render(settings);
    setSaveStatus("Loaded", "idle");
    setPanelStatus(currentViewingItem ? "" : "Scroll to content to begin.", "neutral");
  } catch (error) {
    console.error("[Vigil v2] Failed to load settings", error);
    setSaveStatus("Load failed", "error");
    setPanelStatus("Failed to load settings.", "error");
  }

  subscribeSettings((settings) => render(settings));
  clearContentAnalysis();
  updateDiagnostics();
  void updateCacheStats();
  void settingsCtrl.checkServerAndLoadPlugins();
}

void init();
