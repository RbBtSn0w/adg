import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { isExposed } from "../components.ts";
import { mcpConfigPath } from "../mcp.ts";
import type { AdapterResult } from "./index.ts";

export const ANTIGRAVITY_MCP_CONFIG = "mcp_config.json";

/**
 * Generate an Antigravity (`agy`) plugin.json from an ADG manifest.
 *
 * Antigravity discovers a plugin by scanning a directory for a root `plugin.json`
 * plus sibling component dirs and `mcp_config.json`, so the manifest is emitted
 * at the plugin folder root and contains only the plugin name.
 */
export function toAntigravityManifest(
  _pluginDir: string,
  manifest: AdgManifest,
  _selection?: PluginSelection,
): AdapterResult {
  return { defaultPath: "plugin.json", manifest: { name: manifest.name } };
}

/** Materialize ADG's MCP pointer under Antigravity's required conventional name. */
export function writeAntigravityMcpConfig(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): void {
  const target = join(pluginDir, ANTIGRAVITY_MCP_CONFIG);
  const mcp = mcpConfigPath(manifest);
  const source = mcp ? resolve(pluginDir, mcp) : undefined;

  // An authored mcp_config.json is already the canonical payload, not a
  // generated projection. Never remove or copy it onto itself.
  if (source === resolve(target)) return;

  rmSync(target, { force: true });
  if (source && isExposed(selection, "mcp") && existsSync(source)) {
    cpSync(source, target);
  }
}
