import type { Finding } from "../shared/findings";
import { PLUGIN_ID as COGNITIVE_BIAS_TRIGGER_LLM_PLUGIN_ID, CognitiveBiasTriggerLLMPlugin } from "./cognitiveBiasTrigger/llm";
import { PLUGIN_ID as COGNITIVE_BIAS_TRIGGER_REGEX_PLUGIN_ID, CognitiveBiasTriggerRegexPlugin } from "./cognitiveBiasTrigger/regex";
import type { BrowserPlugin, PluginAnalyzeResult, PluginContext, ReformulationResult } from "./types";

export class BrowserPluginRegistry {
  private readonly plugins = new Map<string, BrowserPlugin>();

  constructor(initialPlugins: BrowserPlugin[] = []) {
    for (const plugin of initialPlugins) {
      this.register(plugin);
    }
  }

  public register(plugin: BrowserPlugin): void {
    this.plugins.set(plugin.metadata.id, plugin);
  }

  public get(pluginId: string): BrowserPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  public list(): BrowserPlugin[] {
    return Array.from(this.plugins.values());
  }

  public async analyzeWith(
    pluginId: string,
    text: string,
    context: PluginContext,
  ): Promise<PluginAnalyzeResult> {
    const plugin = this.get(pluginId);
    if (!plugin) {
      return { findings: [], tips: [] };
    }

    return plugin.analyze(text, context);
  }

  public async reformulateWith(
    pluginId: string,
    text: string,
    findings: Finding[],
    context: PluginContext,
  ): Promise<ReformulationResult | null> {
    const plugin = this.get(pluginId);
    if (!plugin?.reformulate || !plugin.metadata.canReformulate) {
      return null;
    }
    return plugin.reformulate(text, findings, context);
  }
}

export const browserPluginRegistry = new BrowserPluginRegistry([
  new CognitiveBiasTriggerRegexPlugin(),
  new CognitiveBiasTriggerLLMPlugin(),
]);

export const DEFAULT_BROWSER_PLUGIN_ID = COGNITIVE_BIAS_TRIGGER_REGEX_PLUGIN_ID;
export { COGNITIVE_BIAS_TRIGGER_LLM_PLUGIN_ID, COGNITIVE_BIAS_TRIGGER_REGEX_PLUGIN_ID };

