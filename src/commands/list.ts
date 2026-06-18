import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { readManifest } from "../manifest.ts";
import { exposedContents, pluginContents, type PluginContents } from "../components.ts";
import type { LockEntry } from "../types.ts";

export type { PluginContents };

export interface ListedPlugin extends LockEntry {
  name: string;
  /** What the installed plugin exposes (honoring any partial-install selection). */
  contents?: PluginContents;
}

/** List plugins recorded in a plugins directory's .plugin-lock.json. */
export function listPlugins(pluginsDir: string): ListedPlugin[] {
  const lock = readLock(lockPath(pluginsDir));
  return Object.entries(lock.plugins).map(([name, entry]) => {
    const dir = installedPluginDir(pluginsDir, name, entry.origin);
    let contents: PluginContents | undefined;
    try {
      contents = exposedContents(pluginContents(dir, readManifest(dir)), entry.selection);
    } catch {
      contents = undefined; // no/invalid manifest on disk — show provenance only
    }
    return { name, ...entry, contents };
  });
}
