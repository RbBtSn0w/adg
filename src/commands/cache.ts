import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLock } from "../lock.ts";
import { legacyPluginSourceCacheDir, lockPath, pluginCacheRoot, pluginSourceCacheDir } from "../paths.ts";
import { resolvePluginSourceSnapshot } from "../source-cache.ts";
import type { LockEntry } from "../types.ts";

export interface PluginCacheEntry {
  name: string;
  path: string;
  bytes: number;
  orphan: boolean;
  recovery?: "present" | "legacy" | "missing-recoverable" | "missing-unrecoverable";
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
  const lock = readLock(lockPath(pluginsDir));
  const installed = new Set(Object.keys(lock.plugins));
  let entries: PluginCacheEntry[] = [];
  try {
    if (existsSync(root)) {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => {
          const path = join(root, entry.name);
          return { name: entry.name, path, bytes: directoryBytes(path), orphan: !installed.has(entry.name), recovery: "present" as const };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch {
    // Treat an unreadable or concurrently removed directory as empty.
  }
  for (const [name, entry] of Object.entries(lock.plugins)) {
    if (entries.some((item) => item.name === name)) continue;
    const legacy = legacyPluginSourceCacheDir(pluginsDir, name);
    const localRecoverable = entry.origin.type === "local" && existsSync(join(pluginsDir, entry.origin.path));
    const remoteRecoverable = (entry.origin.type === "github" || entry.origin.type === "git") && Boolean(entry.resolvedRevision);
    const hasLegacy = existsSync(legacy);
    entries.push({
      name,
      path: hasLegacy ? legacy : pluginSourceCacheDir(pluginsDir, name),
      bytes: hasLegacy ? directoryBytes(legacy) : 0,
      orphan: false,
      recovery: hasLegacy ? "legacy" : (localRecoverable || remoteRecoverable ? "missing-recoverable" : "missing-unrecoverable"),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { root, entries, totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
}

/** Restore the selected snapshots with lock-hash verification. */
export function restorePluginCache(pluginsDir: string, names?: string[]): string[] {
  const lock = readLock(lockPath(pluginsDir));
  const selected = names?.length ? [...new Set(names)] : Object.keys(lock.plugins);
  const missing = selected.filter((name) => !lock.plugins[name]);
  if (missing.length > 0) throw new Error(`not installed: ${missing.join(", ")}. See \`adg plugins list\`.`);
  return selected.map((name) => {
    resolvePluginSourceSnapshot(pluginsDir, name, lock.plugins[name] as LockEntry);
    return name;
  });
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
