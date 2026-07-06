import { listPlugins, type ListedPlugin } from "./list.ts";
import { relative } from "node:path";
import type { AdapterTarget } from "../adapters/index.ts";
import { ADAPTER_TARGETS } from "../adapters/index.ts";
import { installPlugin, type InstallResult } from "./install.ts";
import { pluginRematerializationSource } from "../paths.ts";

/**
 * Shared selection for the projection verbs (link / unlink / sync). Resolve which
 * installed plugins to act on: the named subset (validated against the store), or
 * every installed plugin when no names are given. Throws — naming the unknown
 * plugins — so a typo surfaces rather than silently no-op'ing, and dedupes
 * repeats so `sync foo foo` acts on `foo` once. Centralized here (not in any one
 * verb) so all three select identically.
 */
export function selectInstalled(pluginsDir: string, names?: string[]): ListedPlugin[] {
  const all = listPlugins(pluginsDir);
  if (!names || names.length === 0) return all;
  const byName = new Map(all.map((p) => [p.name, p]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new Error(`not installed: ${missing.join(", ")}. See \`adg plugins list\`.`);
  }
  const seen = new Set<string>();
  const picked: ListedPlugin[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    picked.push(byName.get(n)!);
  }
  return picked;
}

/** Keep only the generated manifest reported for one runtime target. */
export function adaptedFilesForTarget(
  installedTo: string,
  files: readonly string[],
  target: AdapterTarget,
): string[] {
  const expected = target === "antigravity" ? "plugin.json" : `.${target}-plugin/plugin.json`;
  return files.filter((file) => relative(installedTo, file).split("\\").join("/") === expected);
}

/** Rebuild runtime projections for installed plugins from their cached ADG source. */
export function rematerializeInstalled(
  pluginsDir: string,
  plugins: readonly ListedPlugin[],
): InstallResult[] {
  return plugins.map((plugin) =>
    installPlugin({
      source: pluginRematerializationSource(pluginsDir, plugin.name, plugin.origin),
      pluginsDir,
      origin: plugin.origin,
      selection: plugin.selection,
      targets: [...ADAPTER_TARGETS],
      forceMaterialize: true,
    }));
}
