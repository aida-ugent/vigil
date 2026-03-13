/**
 * Settings panel controller. Owns all DOM interactions for the Settings tab:
 * plugin checkboxes, LLM backend selection, cloud/local/WebLLM config fields,
 * sensitivity selector, server URL, and reset button.
 *
 * Receives state from the sidepanel orchestrator; emits settings patches.
 */

import type {
  DefaultAction,
  LLMBackend,
  Sensitivity,
  VigilSettings,
} from "../shared/settings";
import {
  resetSettings,
  updateSettings,
} from "../shared/settingsStorage";
import { getWebLLMService } from "../llm/webllm";
import { browserPluginRegistry } from "../plugins/registry";
import { createServerClient, type ServerClient } from "../plugins/server/client";

type StatusCallback = (message: string, state: "idle" | "saved" | "error") => void;
type PanelStatusCallback = (message: string, tone: "neutral" | "success" | "warning" | "error") => void;
type DiagnosticsCallback = () => void;

export interface SettingsControllerDeps {
  onSaveStatus: StatusCallback;
  onPanelStatus: PanelStatusCallback;
  onDiagnosticsChanged: DiagnosticsCallback;
  getCurrentSettings: () => VigilSettings;
  setCurrentSettings: (s: VigilSettings) => void;
}

const webLLMService = getWebLLMService();

// ── DOM refs ──

const browserPluginsList = document.getElementById("browser-plugins-list");
const llmProviderSection = document.getElementById("llm-provider-section");
const llmBackendSelect = document.getElementById("llm-backend");
const cloudSettingsGroup = document.getElementById("cloud-settings-group");
const cloudApiKeyInput = document.getElementById("cloud-api-key");
const cloudBaseUrlInput = document.getElementById("cloud-base-url");
const cloudModelInput = document.getElementById("cloud-model-id");
const localSettingsGroup = document.getElementById("local-settings-group");
const localBaseUrlInput = document.getElementById("local-base-url");
const localModelInput = document.getElementById("local-model-id");
const webllmSettingsGroup = document.getElementById("webllm-settings-group");
const webllmModelSelect = document.getElementById("webllm-model-id");
const webllmLoadButton = document.getElementById("webllm-load-btn");
const webllmUnloadButton = document.getElementById("webllm-unload-btn");
const webllmStatusChip = document.getElementById("webllm-status-chip");
const webllmProgressFill = document.getElementById("webllm-progress-fill");
const webllmProgressText = document.getElementById("webllm-progress-text");
const autoAnalyzeCheckbox = document.getElementById("auto-analyze");
const serverUrlInput = document.getElementById("server-url");
const serverStatusDot = document.getElementById("server-status-dot");
const serverCheckBtn = document.getElementById("server-check-btn");
const serverPluginsList = document.getElementById("server-plugins-list");
const resetButton = document.getElementById("reset-btn");
const sensitivityButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-sensitivity]"),
);
const defaultActionSelect = document.getElementById("default-action");

// ── Helpers ──

function formatSavedTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function webllmStatusLabel(status: ReturnType<typeof webLLMService.getStatus>): string {
  if (status === "loading") return "Loading";
  if (status === "ready") return "Ready";
  if (status === "error") return "Error";
  return "Not loaded";
}

// ── Shared plugin renderer ──

interface PluginItemOptions {
  id: string;
  name: string;
  description: string;
  checked: boolean;
  badge?: { label: string; cssClass: string };
  onChange: (checked: boolean) => void;
}

/** Renders a single plugin row. Used for both browser and server plugins. */
function renderPluginItem(opts: PluginItemOptions): HTMLLabelElement {
  const item = document.createElement("label");
  item.className = "plugin-item";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = opts.checked;
  cb.dataset.pluginId = opts.id;
  cb.addEventListener("change", () => opts.onChange(cb.checked));

  const nameSpan = document.createElement("span");
  nameSpan.className = "plugin-name";
  nameSpan.textContent = opts.name;

  item.appendChild(cb);
  item.appendChild(nameSpan);

  if (opts.badge) {
    const badge = document.createElement("span");
    badge.className = `plugin-badge ${opts.badge.cssClass}`;
    badge.textContent = opts.badge.label;
    item.appendChild(badge);
  }

  const info = document.createElement("span");
  info.className = "plugin-info";
  info.setAttribute("data-tooltip", opts.description);
  info.textContent = "ℹ";
  item.appendChild(info);

  return item;
}

// ── Controller ──

export function createSettingsController(deps: SettingsControllerDeps) {
  let serverClient: ServerClient = createServerClient(deps.getCurrentSettings().serverUrl);

  async function persistPatch(patch: Partial<VigilSettings>): Promise<void> {
    try {
      await updateSettings(patch);
      deps.onSaveStatus(`Saved at ${formatSavedTime()}`, "saved");
    } catch (error) {
      console.error("[Vigil v2] Failed to save settings", error);
      deps.onSaveStatus("Save failed", "error");
    }
  }

  // ── Backend visibility ──

  function updateBackendVisibility(backend: LLMBackend): void {
    if (cloudSettingsGroup) cloudSettingsGroup.style.display = backend === "cloud-api" ? "" : "none";
    if (localSettingsGroup) localSettingsGroup.style.display = backend === "local-api" ? "" : "none";
    if (webllmSettingsGroup) webllmSettingsGroup.style.display = backend === "webllm" ? "" : "none";
    renderWebLLMControls();
  }

  function anySelectedPluginNeedsLLM(pluginIds: string[]): boolean {
    return pluginIds.some((id) => {
      const plugin = browserPluginRegistry.get(id);
      return plugin?.metadata.requiresLLM === true;
    });
  }

  function updateLlmSectionVisibility(): void {
    const settings = deps.getCurrentSettings();
    const needsLlm = anySelectedPluginNeedsLLM(settings.selectedBrowserPlugins);
    if (llmProviderSection) llmProviderSection.style.display = needsLlm ? "" : "none";
  }

  // ── WebLLM ──

  function renderWebLLMControls(): void {
    const settings = deps.getCurrentSettings();
    const status = webLLMService.getStatus();
    const progress = webLLMService.getProgress();
    const isWebLLMBackend = settings.llmBackend === "webllm";
    const pct = Math.round(Math.min(1, Math.max(0, progress.progress)) * 100);
    if (webllmStatusChip) { webllmStatusChip.textContent = webllmStatusLabel(status); webllmStatusChip.setAttribute("data-state", status); }
    if (webllmProgressText) webllmProgressText.textContent = `${pct}% • ${progress.text}`;
    if (webllmProgressFill) { webllmProgressFill.setAttribute("style", `width: ${pct}%`); const bar = webllmProgressFill.parentElement; if (bar) bar.setAttribute("aria-valuenow", String(pct)); }
    if (webllmLoadButton instanceof HTMLButtonElement) webllmLoadButton.disabled = !isWebLLMBackend || status === "loading" || status === "ready";
    if (webllmUnloadButton instanceof HTMLButtonElement) webllmUnloadButton.disabled = !isWebLLMBackend || (status !== "ready" && status !== "error");
    deps.onDiagnosticsChanged();
  }

  // ── Sensitivity ──

  function setActiveSensitivity(sensitivity: Sensitivity): void {
    for (const button of sensitivityButtons) {
      const value = Number(button.dataset.sensitivity);
      const isActive = value === sensitivity;
      button.setAttribute("aria-pressed", String(isActive));
      button.classList.toggle("is-active", isActive);
    }
  }

  function setDefaultActionValue(action: DefaultAction): void {
    if (defaultActionSelect instanceof HTMLSelectElement) defaultActionSelect.value = action;
  }

  // ── Server plugin discovery ──

  async function checkServerAndLoadPlugins(): Promise<void> {
    const settings = deps.getCurrentSettings();
    if (serverStatusDot) serverStatusDot.setAttribute("data-state", "unknown");

    const healthy = await serverClient.checkHealth();
    if (serverStatusDot) serverStatusDot.setAttribute("data-state", healthy ? "online" : "offline");
    if (!healthy || !serverPluginsList) {
      if (serverPluginsList) serverPluginsList.style.display = "none";
      return;
    }

    try {
      const resp = await serverClient.fetchPlugins();
      serverPluginsList.style.display = "";
      serverPluginsList.innerHTML = "";
      for (const p of resp.analyzers) {
        const desc = p.active_model
          ? `${p.description} (model: ${p.active_model})`
          : p.description;

        const el = renderPluginItem({
          id: p.id,
          name: p.name,
          description: desc,
          checked: settings.selectedPlugins.includes(p.id),
          badge: { label: "🌐", cssClass: "plugin-badge--server" },
          onChange: (checked) => {
            const current = new Set(deps.getCurrentSettings().selectedPlugins);
            if (checked) current.add(p.id); else current.delete(p.id);
            void persistPatch({ selectedPlugins: [...current] });
          },
        });
        serverPluginsList.appendChild(el);
      }
    } catch (error) {
      console.warn("[Vigil v2] Failed to fetch server plugins:", error);
      serverPluginsList.style.display = "none";
    }
  }

  // ── Browser plugin discovery & rendering ──

  function renderBrowserPlugins(): void {
    if (!browserPluginsList) return;
    const settings = deps.getCurrentSettings();
    browserPluginsList.innerHTML = "";

    for (const plugin of browserPluginRegistry.list()) {
      const { id, name, description, requiresLLM } = plugin.metadata;
      const badge = requiresLLM
        ? { label: "⚡ LLM", cssClass: "plugin-badge--llm" }
        : undefined;

      const el = renderPluginItem({
        id,
        name,
        description,
        checked: settings.selectedBrowserPlugins.includes(id),
        badge,
        onChange: () => persistPluginSelection(),
      });
      browserPluginsList.appendChild(el);
    }
  }

  // ── Plugin selection ──

  function buildBrowserPluginList(): string[] {
    if (!browserPluginsList) return [];
    const list: string[] = [];
    for (const cb of Array.from(browserPluginsList.querySelectorAll<HTMLInputElement>("input[data-plugin-id]"))) {
      if (cb.checked && cb.dataset.pluginId) list.push(cb.dataset.pluginId);
    }
    return list;
  }

  function persistPluginSelection(): void {
    const bp = buildBrowserPluginList();
    const settings = deps.getCurrentSettings();
    const llmOn = anySelectedPluginNeedsLLM(bp);
    const llmBackend = (llmOn && settings.llmBackend === "none") ? "local-api" : settings.llmBackend;
    deps.setCurrentSettings({ ...settings, selectedBrowserPlugins: bp });
    void persistPatch({ selectedBrowserPlugins: bp, llmBackend });
    updateLlmSectionVisibility();
    deps.onDiagnosticsChanged();
  }

  // ── render (called on every settings load/update) ──

  function render(settings: VigilSettings): void {
    if (settings.serverUrl !== deps.getCurrentSettings().serverUrl) {
      serverClient = createServerClient(settings.serverUrl);
    }

    renderBrowserPlugins();

    const effectiveBackend = settings.llmBackend === "none" ? "local-api" : settings.llmBackend;
    if (llmBackendSelect instanceof HTMLSelectElement) llmBackendSelect.value = effectiveBackend;
    updateLlmSectionVisibility();
    updateBackendVisibility(effectiveBackend);

    if (cloudApiKeyInput instanceof HTMLInputElement) cloudApiKeyInput.value = settings.cloudApiKey;
    if (cloudBaseUrlInput instanceof HTMLInputElement) cloudBaseUrlInput.value = settings.cloudApiBaseUrl;
    if (cloudModelInput instanceof HTMLInputElement) cloudModelInput.value = settings.cloudModelId;
    if (localBaseUrlInput instanceof HTMLInputElement) localBaseUrlInput.value = settings.localApiBaseUrl;
    if (localModelInput instanceof HTMLInputElement) localModelInput.value = settings.localModelId;
    if (webllmModelSelect instanceof HTMLSelectElement) webllmModelSelect.value = settings.webllmModelId;
    if (autoAnalyzeCheckbox instanceof HTMLInputElement) autoAnalyzeCheckbox.checked = settings.autoAnalyze;
    if (serverUrlInput instanceof HTMLInputElement) serverUrlInput.value = settings.serverUrl;
    setActiveSensitivity(settings.sensitivity);
    setDefaultActionValue(settings.defaultAction);
    renderWebLLMControls();
  }

  // ── bind ──

  function bind(): void {
    if (llmBackendSelect instanceof HTMLSelectElement) {
      llmBackendSelect.addEventListener("change", () => {
        const backend = llmBackendSelect.value as LLMBackend;
        updateBackendVisibility(backend);
        void persistPatch({ llmBackend: backend });
      });
    }

    function bindInputSave(el: HTMLElement | null, key: keyof VigilSettings): void {
      if (!(el instanceof HTMLInputElement)) return;
      const save = (): void => { void persistPatch({ [key]: el.value.trim() } as Partial<VigilSettings>); };
      el.addEventListener("change", save);
      el.addEventListener("blur", save);
    }

    bindInputSave(cloudApiKeyInput, "cloudApiKey");
    bindInputSave(cloudBaseUrlInput, "cloudApiBaseUrl");
    bindInputSave(cloudModelInput, "cloudModelId");
    bindInputSave(localBaseUrlInput, "localApiBaseUrl");
    bindInputSave(localModelInput, "localModelId");

    for (const button of sensitivityButtons) {
      button.addEventListener("click", () => {
        const rawValue = Number(button.dataset.sensitivity);
        if (rawValue !== 1 && rawValue !== 2 && rawValue !== 3) return;
        void persistPatch({ sensitivity: rawValue });
      });
    }

    if (defaultActionSelect instanceof HTMLSelectElement) {
      defaultActionSelect.addEventListener("change", () => {
        void persistPatch({ defaultAction: defaultActionSelect.value as DefaultAction });
      });
    }

    if (autoAnalyzeCheckbox instanceof HTMLInputElement)
      autoAnalyzeCheckbox.addEventListener("change", () => void persistPatch({ autoAnalyze: autoAnalyzeCheckbox.checked }));

    if (serverUrlInput instanceof HTMLInputElement) {
      const saveUrl = (): void => { const v = serverUrlInput.value.trim(); if (!v.length) { deps.onSaveStatus("Server URL cannot be empty", "error"); return; } void persistPatch({ serverUrl: v }); };
      serverUrlInput.addEventListener("change", saveUrl);
      serverUrlInput.addEventListener("blur", saveUrl);
    }

    if (resetButton instanceof HTMLButtonElement) {
      resetButton.addEventListener("click", async () => {
        try { await resetSettings(); deps.onSaveStatus(`Reset at ${formatSavedTime()}`, "saved"); }
        catch (error) { console.error("[Vigil v2] Failed to reset settings", error); deps.onSaveStatus("Reset failed", "error"); }
      });
    }

    if (serverCheckBtn) {
      serverCheckBtn.addEventListener("click", () => void checkServerAndLoadPlugins());
    }

    // WebLLM actions
    webLLMService.onProgress(() => renderWebLLMControls());
    if (webllmModelSelect instanceof HTMLSelectElement) {
      webllmModelSelect.addEventListener("change", () => void persistPatch({ webllmModelId: webllmModelSelect.value as VigilSettings["webllmModelId"] }));
    }
    if (webllmLoadButton instanceof HTMLButtonElement) {
      webllmLoadButton.addEventListener("click", () => {
        void (async () => {
          const modelId = deps.getCurrentSettings().webllmModelId;
          try { await webLLMService.init(modelId); renderWebLLMControls(); deps.onSaveStatus(`WebLLM ready (${modelId})`, "saved"); deps.onPanelStatus(`Browser AI model ${modelId} loaded and ready.`, "success"); }
          catch (error) { const msg = error instanceof Error ? error.message : "Model load failed"; deps.onSaveStatus(`WebLLM error: ${msg}`, "error"); deps.onPanelStatus(`WebLLM error: ${msg}`, "error"); renderWebLLMControls(); }
        })();
      });
    }
    if (webllmUnloadButton instanceof HTMLButtonElement) {
      webllmUnloadButton.addEventListener("click", () => {
        void (async () => {
          try { await webLLMService.unload(); renderWebLLMControls(); deps.onSaveStatus("WebLLM model unloaded", "saved"); deps.onPanelStatus("Browser AI model unloaded.", "neutral"); }
          catch (error) { const msg = error instanceof Error ? error.message : "Unload failed"; deps.onSaveStatus(`WebLLM unload failed: ${msg}`, "error"); deps.onPanelStatus(`WebLLM unload failed: ${msg}`, "error"); renderWebLLMControls(); }
        })();
      });
    }
  }

  return { render, bind, checkServerAndLoadPlugins, getWebLLMService: () => webLLMService };
}
