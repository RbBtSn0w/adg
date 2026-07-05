import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";
import { installedPluginDir, lockPath, pluginSourceCacheDir } from "../paths.ts";
import { readLock } from "../lock.ts";
import { installPlugin } from "./install.ts";

export interface UpdateResult {
  name: string;
  changed: boolean;
  version: string;
  sourceHash: string;
  installedHash: string;
}

export interface UpdateOptions {
  resync?: boolean;
  scope?: AgentScope;
  only?: string[];
  agents?: Agent[];
}

export interface UpdateLockResult {
  results: UpdateResult[];
  missing: string[];
  agents?: AgentSyncResult[];
}

/**
 * Refresh local sources and repair effective installations from their complete
 * source snapshots. Runtime installations are never treated as upstream input.
 */
export function updateLock(
  pluginsDir: string,
  now: string = new Date().toISOString(),
  opts: UpdateOptions = {},
): UpdateLockResult {
  const snapshot = readLock(lockPath(pluginsDir));
  const only = opts.only ? new Set(opts.only) : undefined;
  const results: UpdateResult[] = [];
  const missing: string[] = [];
  const changedNames: string[] = [];

  for (const [name, entry] of Object.entries(snapshot.plugins)) {
    if (only && !only.has(name)) continue;
    const installedDir = installedPluginDir(pluginsDir, name, entry.origin);
    const localSource = entry.origin.type === "local" && resolve(entry.origin.path) !== resolve(installedDir)
      ? entry.origin.path
      : undefined;
    const cache = pluginSourceCacheDir(pluginsDir, name);
    const source = localSource && existsSync(localSource) ? localSource : cache;
    if (!existsSync(source)) {
      missing.push(name);
      continue;
    }

    const result = installPlugin({
      source,
      pluginsDir,
      origin: entry.origin,
      selection: entry.selection,
      skipUnchanged: true,
      now,
    });
    const current = readLock(lockPath(pluginsDir)).plugins[name]!;
    if (result.changed) changedNames.push(name);
    results.push({
      name,
      changed: result.changed,
      version: current.version,
      sourceHash: result.sourceHash,
      installedHash: result.installedHash,
    });
  }

  const out: UpdateLockResult = { results, missing };
  if (opts.resync && changedNames.length > 0) {
    const ctx = { pluginsDir, plugins: changedNames, scope: opts.scope ?? "project" };
    out.agents = (opts.agents ?? resolveAgents()).map((agent) => agent.refresh(ctx));
  }
  return out;
}
