import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { isExposed } from "../components.ts";
import { mcpConfigPath } from "../mcp.ts";
import type { AdapterResult } from "./index.ts";

/** Projection subdirectory that holds the self-contained agy plugin root. */
export const ANTIGRAVITY_PROJECTION_DIR = ".antigravity-plugin";

/**
 * Generate an Antigravity (`agy`) plugin.json from an ADG manifest.
 *
 * Antigravity reads the same plugin.json MCP pointer shape as the other plugin
 * runtimes (`mcpServers`). The agent-side projection still materializes a
 * self-contained root for partial installs by copying the referenced file next
 * to plugin.json and linking selected component dirs.
 */
export function toAntigravityManifest(
  _pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  const out: Record<string, unknown> = { name: manifest.name };
  const mcp = mcpConfigPath(manifest);
  if (mcp && isExposed(selection, "mcp")) out.mcpServers = mcp;
  return { defaultPath: join(ANTIGRAVITY_PROJECTION_DIR, "plugin.json"), manifest: out };
}
