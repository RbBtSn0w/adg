import { join } from "node:path";
import { ADAPTERS, type AdapterTarget } from "../adapters/index.ts";
import { readManifest } from "../manifest.ts";
import { writeJson } from "../fsutil.ts";
import { checkHookEvents } from "../hooks.ts";
import { writeAntigravityMcpConfig } from "../adapters/antigravity.ts";
import type { PluginSelection } from "../types.ts";

export interface AdaptResult {
  target: string;
  file: string;
}

/**
 * Generate runtime-specific manifests for the given targets from a plugin's
 * .agents/.plugin.json. The output path honors the manifest's `adapters`
 * mapping when present, otherwise falls back to the adapter's default path.
 * An optional `selection` narrows what the generated manifests expose.
 */
export function adaptPlugin(pluginDir: string, targets: AdapterTarget[], selection?: PluginSelection): AdaptResult[] {
  const manifest = readManifest(pluginDir);
  const results: AdaptResult[] = [];

  // Lint the plugin's hooks against each target's event support: a hook on an
  // event a target can't fire (e.g. a Claude-only event projected to Codex) is a
  // silent no-op otherwise. Read-only — ADG never transforms hooks.
  for (const w of checkHookEvents(pluginDir, targets)) console.error(`hooks: ${w}`);

  for (const target of targets) {
    const adapter = ADAPTERS[target];
    if (!adapter) throw new Error(`unknown adapter target: ${target}`);
    const { defaultPath, manifest: out } = adapter(pluginDir, manifest, selection);

    // Output paths are ADG-internal conventions, not producer-configurable: each
    // runtime mandates its own (.claude-plugin/ , .codex-plugin/).
    const file = join(pluginDir, defaultPath);

    writeJson(file, out);
    if (target === "antigravity") writeAntigravityMcpConfig(pluginDir, manifest, selection);
    results.push({ target, file });
  }

  return results;
}
