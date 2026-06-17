import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LOCK_VERSION, type LockEntry, type PluginLock } from "./types.ts";

export function emptyLock(): PluginLock {
  return { version: LOCK_VERSION, plugins: {} };
}

export function readLock(file: string): PluginLock {
  if (!existsSync(file)) return emptyLock();
  const raw = JSON.parse(readFileSync(file, "utf8")) as PluginLock;
  if (typeof raw.version !== "number" || typeof raw.plugins !== "object" || raw.plugins === null) {
    throw new Error(`${file} is not a valid .plugin-lock.json`);
  }
  // Pre-release policy: a lock from an older format version is fully
  // regenerable from the plugin directories, so rebuild rather than merge
  // incompatible entry shapes.
  if (raw.version !== LOCK_VERSION) return emptyLock();
  return raw;
}

export function writeLock(file: string, lock: PluginLock): void {
  writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
}

/**
 * Remove a plugin entry from the lock. Drops it from `lastSelected` too.
 * Returns true if an entry was actually removed.
 */
export function removeEntry(lock: PluginLock, name: string): boolean {
  if (!(name in lock.plugins)) return false;
  delete lock.plugins[name];
  if (lock.lastSelected) {
    lock.lastSelected = lock.lastSelected.filter((n) => n !== name);
    if (lock.lastSelected.length === 0) delete lock.lastSelected;
  }
  return true;
}

/**
 * Insert or update a plugin entry. Preserves the original installedAt on update
 * and always refreshes updatedAt. `lastSelected` is set to the touched plugin.
 */
export function upsertEntry(
  lock: PluginLock,
  name: string,
  entry: Omit<LockEntry, "installedAt" | "updatedAt">,
  now: string = new Date().toISOString(),
): PluginLock {
  const prev = lock.plugins[name];
  lock.plugins[name] = {
    ...entry,
    installedAt: prev?.installedAt ?? now,
    updatedAt: now,
  };
  lock.lastSelected = [name];
  return lock;
}
