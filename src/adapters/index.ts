import type { AdgManifest, PluginSelection } from "../types.ts";
import { toAnthropicManifest } from "./anthropic.ts";
import { toCodexManifest } from "./openai.ts";

export interface AdapterResult {
  /** Default manifest path relative to the plugin directory. */
  defaultPath: string;
  /** The generated runtime-specific manifest object. */
  manifest: Record<string, unknown>;
}

export type AdapterFn = (pluginDir: string, manifest: AdgManifest, selection?: PluginSelection) => AdapterResult;

export const ADAPTERS: Record<string, AdapterFn> = {
  claude: toAnthropicManifest,
  anthropic: toAnthropicManifest,
  codex: toCodexManifest,
  openai: toCodexManifest,
};

export const ADAPTER_TARGETS = ["claude", "codex"] as const;
export type AdapterTarget = (typeof ADAPTER_TARGETS)[number];

export { toAnthropicManifest, toCodexManifest };
