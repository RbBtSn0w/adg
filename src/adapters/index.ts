import type { AdgManifest, ComponentType, PluginSelection } from "../types.ts";
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

/**
 * Component categories each adapter target can actually express, mirroring what
 * the adapters emit: the Claude manifest carries skills/agents/commands/hooks/mcp
 * (`toAnthropicManifest`), while Codex only consumes skills (`toCodexManifest`).
 * `apps` is emitted by neither, so it maps to no target. Used to derive which
 * agents a plugin is adaptable to from its exposed component types.
 */
export const ADAPTER_COMPONENTS: Record<AdapterTarget, ComponentType[]> = {
  claude: ["skills", "agents", "commands", "hooks", "mcp"],
  codex: ["skills"],
};

export { toAnthropicManifest, toCodexManifest };
