import { listPlugins, type ListedPlugin } from "./list.ts";

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
