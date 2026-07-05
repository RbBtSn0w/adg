import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLock } from "../lock.ts";
import { lockPath, pluginCacheRoot } from "../paths.ts";

export interface PluginCacheEntry {
  name: string;
  path: string;
  bytes: number;
  orphan: boolean;
}

export interface PluginCacheStatus {
  root: string;
  entries: PluginCacheEntry[];
  totalBytes: number;
}

export function directoryBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += directoryBytes(path);
      else if (entry.isFile()) {
        try {
          total += statSync(path).size;
        } catch {
          // A concurrent cache mutation must not make status fail.
        }
      }
    }
  } catch {
    // Treat an unreadable or concurrently removed directory as empty.
  }
  return total;
}

export function pluginCacheStatus(pluginsDir: string): PluginCacheStatus {
  const root = pluginCacheRoot(pluginsDir);
  const installed = new Set(Object.keys(readLock(lockPath(pluginsDir)).plugins));
  const entries = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const path = join(root, entry.name);
        return { name: entry.name, path, bytes: directoryBytes(path), orphan: !installed.has(entry.name) };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return { root, entries, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** Delete cache snapshots that have no corresponding lock entry. */
export function prunePluginCache(pluginsDir: string): string[] {
  const status = pluginCacheStatus(pluginsDir);
  const removed = status.entries.filter((entry) => entry.orphan);
  for (const entry of removed) rmSync(entry.path, { recursive: true, force: true });
  if (existsSync(status.root) && readdirSync(status.root).length === 0) rmSync(status.root, { recursive: true, force: true });
  return removed.map((entry) => entry.name);
}

/** Delete every rebuildable source snapshot for this store. */
export function cleanPluginCache(pluginsDir: string): void {
  rmSync(pluginCacheRoot(pluginsDir), { recursive: true, force: true });
}
