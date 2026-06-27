import type { AdgManifest, PluginSelection } from "../types.ts";
import { isExposed } from "../components.ts";
import { mcpConfigPath } from "../mcp.ts";
import type { AdapterResult } from "./index.ts";

/**
 * Generate an Antigravity (`agy`) plugin.json from an ADG manifest.
 *
 * Antigravity discovers a plugin by scanning a directory for a root `plugin.json`
 * plus sibling component dirs, so the manifest is emitted at the plugin folder
 * root. It reads the same `mcpServers` pointer shape as the other runtimes.
 */
export function toAntigravityManifest(
  _pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  const out: Record<string, unknown> = { name: manifest.name };
  const mcp = mcpConfigPath(manifest);
  if (mcp && isExposed(selection, "mcp")) out.mcpServers = mcp;
  return { defaultPath: "plugin.json", manifest: out };
}
