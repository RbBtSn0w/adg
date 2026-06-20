import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import type { AdapterResult } from "./index.ts";

/** Projection subdirectory that holds the self-contained agy plugin root. */
export const ANTIGRAVITY_PROJECTION_DIR = ".antigravity-plugin";

/**
 * Generate an Antigravity (`agy`) plugin.json from an ADG manifest.
 *
 * Antigravity's manifest is minimal: it reads only `name` from a `plugin.json`
 * and discovers components by convention (sibling `skills/`, `agents/`,
 * `commands/`, `hooks/` directories plus a `mcp_config.json`) — all resolved
 * relative to the directory handed to `agy plugin install`, with no manifest
 * path indirection. We therefore project a self-contained agy plugin root under
 * `.antigravity-plugin/`: this pure transform emits its `plugin.json`, while the
 * agent materializes the rest (mcp_config.json + symlinked component dirs), so a
 * partial-install `selection` is not expressible for this target.
 */
export function toAntigravityManifest(
  _pluginDir: string,
  manifest: AdgManifest,
  _selection?: PluginSelection,
): AdapterResult {
  return { defaultPath: join(ANTIGRAVITY_PROJECTION_DIR, "plugin.json"), manifest: { name: manifest.name } };
}
