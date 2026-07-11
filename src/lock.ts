import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Span } from "@opentelemetry/api";
import { recordTelemetryEvent } from "./telemetry.ts";
import { LOCK_VERSION, type LockEntry, type PluginLock } from "./types.ts";

/** Compatibility reads are upgraded in memory; record the transition on first successful persistence. */
const pendingLockMigrations = new WeakMap<PluginLock, number>();

export function emptyLock(): PluginLock {
  return { version: LOCK_VERSION, plugins: {} };
}

export function readLock(file: string, telemetrySpan?: Pick<Span, "addEvent">): PluginLock {
  if (!existsSync(file)) return emptyLock();
  const raw = JSON.parse(readFileSync(file, "utf8")) as PluginLock;
  if (typeof raw?.version === "number") {
    const observed = raw.version === 2 || raw.version === 3 || raw.version === LOCK_VERSION ? raw.version : -1;
    recordTelemetryEvent("adg.lock.read", { "format.version": observed }, telemetrySpan);
  }
  if (typeof raw.version !== "number" || typeof raw.plugins !== "object" || raw.plugins === null) {
    throw new Error(`${file} is not a valid .plugin-lock.json`);
  }
  if (raw.version === 3) {
    // Read compatibility for the immediately preceding format keeps runtime
    // adapters working before the user runs the explicit migration command.
    const upgraded = { ...raw, version: LOCK_VERSION };
    pendingLockMigrations.set(upgraded, 3);
    return upgraded;
  }
  if (raw.version !== LOCK_VERSION) {
    throw new Error(
      `${file} uses unsupported lock version ${raw.version}; expected ${LOCK_VERSION}. ` +
        "Run `adg plugins migrate` with the same scope flag to upgrade it.",
    );
  }
  return raw;
}

export function writeLock(file: string, lock: PluginLock, telemetrySpan?: Pick<Span, "addEvent">): void {
  writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
  const fromVersion = pendingLockMigrations.get(lock);
  if (fromVersion !== undefined) {
    pendingLockMigrations.delete(lock);
    recordTelemetryEvent(
      "adg.lock.migrate",
      { "from.version": fromVersion, "to.version": LOCK_VERSION },
      telemetrySpan,
    );
  }
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
