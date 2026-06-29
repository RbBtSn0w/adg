import type { AdgManifest, ComponentType, PluginSelection } from "../types.ts";
import { toAnthropicManifest } from "./anthropic.ts";
import { toCodexManifest } from "./codex.ts";
import { toAntigravityManifest } from "./antigravity.ts";

export interface AdapterResult {
  /** Default manifest path relative to the plugin directory. */
  defaultPath: string;
  /** The generated runtime-specific manifest object. */
  manifest: Record<string, unknown>;
}

export type AdapterFn = (pluginDir: string, manifest: AdgManifest, selection?: PluginSelection) => AdapterResult;

// `anthropic` is kept as a synonym because Claude's plugin.json *is* the
// "anthropic" manifest shape. There is deliberately no `openai` key: the runtime
// is Codex, and an `openai` alias would imply OpenAI support that does not exist.
export const ADAPTERS: Record<string, AdapterFn> = {
  claude: toAnthropicManifest,
  anthropic: toAnthropicManifest,
  codex: toCodexManifest,
  antigravity: toAntigravityManifest,
  agy: toAntigravityManifest,
  gemini: toAntigravityManifest,
};

export const ADAPTER_TARGETS = ["claude", "codex", "antigravity"] as const;
export type AdapterTarget = (typeof ADAPTER_TARGETS)[number];

/**
 * Component categories each adapter target can actually express, mirroring what
 * the adapters emit: the Claude manifest carries skills/agents/commands/hooks/mcp
 * plus apps (`toAnthropicManifest`), while Codex consumes skills/hooks/mcp
 * (`toCodexManifest`). Antigravity (`agy`) discovers components by convention
 * (skills/agents/commands/hooks dirs + `mcp_config.json`) and does not surface
 * apps, so apps maps only to the Claude target. Used to derive which agents a
 * plugin is adaptable to from its exposed component types.
 */
export const ADAPTER_COMPONENTS: Record<AdapterTarget, ComponentType[]> = {
  claude: ["skills", "agents", "commands", "hooks", "mcp", "apps"],
  codex: ["skills", "hooks", "mcp"],
  antigravity: ["skills", "agents", "commands", "hooks", "mcp"],
};

export { toAnthropicManifest, toCodexManifest, toAntigravityManifest };
