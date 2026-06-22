import { existsSync } from "node:fs";
import { folderHash } from "../hash.ts";
import { packageFilter, PROJECTION_DIRS } from "../package.ts";
import { lockPath, installedPluginDir } from "../paths.ts";
import { readLock, writeLock } from "../lock.ts";
import { readManifest } from "../manifest.ts";
import { adaptPlugin } from "./adapt.ts";
import { ADAPTER_TARGETS } from "../adapters/index.ts";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";

export interface UpdateResult {
  name: string;
  changed: boolean;
  version: string;
  folderHash: string;
}

export interface UpdateOptions {
  /**
   * After refreshing the store, re-sync the agents so they pick up the updated
   * content rather than serving a stale cached copy. Off by default. Note this
   * only gates the agent re-sync step: `updateLock` always rewrites the lock
   * file and regenerates runtime manifests for changed plugins regardless of
   * this flag, so the function is not side-effect-free.
   */
  resync?: boolean;
  /** Install scope for re-sync; "user" (global) or "project". */
  scope?: AgentScope;
  /**
   * Restrict the rescan to these plugin names. Used by `updatePlugins` to refresh
   * only the local-source bucket (remote sources are handled by re-fetching).
   * Omitted = rescan every locked plugin.
   */
  only?: string[];
  /** Injection seam for tests; defaults to every registered agent. */
  agents?: Agent[];
}

export interface UpdateLockResult {
  results: UpdateResult[];
  missing: string[];
  /** Per-agent re-sync outcome (when `resync` was set). */
  agents?: AgentSyncResult[];
}

/**
 * Re-scan installed plugins in a plugins directory, refreshing each lock
 * entry's version and folderHash from disk. Entries whose content or version
 * changed are reported as `changed`. A missing plugin directory is reported as
 * an issue rather than silently dropped.
 *
 * Changed plugins always have their runtime manifests regenerated (honoring
 * their selection). With `resync`, the regenerated content is additionally
 * re-installed into the agents so Claude/Codex reflect the new content.
 */
export function updateLock(
  pluginsDir: string,
  now: string = new Date().toISOString(),
  opts: UpdateOptions = {},
): UpdateLockResult {
  const lockFile = lockPath(pluginsDir);
  const lock = readLock(lockFile);
  const results: UpdateResult[] = [];
  const missing: string[] = [];
  const changedNames: string[] = [];

  const only = opts.only ? new Set(opts.only) : undefined;
  for (const [name, entry] of Object.entries(lock.plugins)) {
    if (only && !only.has(name)) continue;
    const dir = installedPluginDir(pluginsDir, name, entry.origin);
    if (!existsSync(dir)) {
      missing.push(name);
      continue;
    }
    const manifest = readManifest(dir);
    const hash = folderHash(dir, PROJECTION_DIRS, packageFilter(manifest, { includeProjections: false }));
    const changed = hash !== entry.folderHash || manifest.version !== entry.version;
    if (changed) {
      entry.folderHash = hash;
      entry.version = manifest.version;
      entry.updatedAt = now;
      // Regenerate runtime manifests from the updated source, honoring selection.
      // Covers every registered adapter target (claude/codex/antigravity) so a
      // projection can't go stale after an update.
      adaptPlugin(dir, [...ADAPTER_TARGETS], entry.selection);
      changedNames.push(name);
    }
    results.push({ name, changed, version: manifest.version, folderHash: hash });
  }

  writeLock(lockFile, lock);

  const out: UpdateLockResult = { results, missing };
  if (opts.resync && changedNames.length > 0) {
    const ctx = { pluginsDir, plugins: changedNames, scope: opts.scope ?? "project" };
    out.agents = (opts.agents ?? resolveAgents()).map((a) => a.refresh(ctx));
  }
  return out;
}
