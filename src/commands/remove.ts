import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { claudeSkillsDir, lockPath, marketplacePath, pluginDir } from "../paths.ts";
import { readLock, removeEntry, writeLock } from "../lock.ts";
import { readMarketplace, removeMarketplacePlugin, writeMarketplace } from "../marketplace.ts";
import { basename } from "node:path";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";

export interface RemoveOptions {
  /** Plugins directory the plugin lives in. */
  pluginsDir: string;
  name: string;
  /** Remove even if other installed plugins depend on it. */
  force?: boolean;
  cwd?: string;
  /** Also uninstall the plugin from the agents via their CLIs. */
  deactivate?: boolean;
  /** Install scope to uninstall from; "user" (global) or "project". */
  scope?: AgentScope;
  /** Injection seam for tests; defaults to every registered agent. */
  agents?: Agent[];
}

export interface RemoveResult {
  name: string;
  /** Plugin directory that was deleted, if it existed. */
  removedDir?: string;
  /** Claude skills symlinks that were cleaned up. */
  unlinked: string[];
  removedFromLock: boolean;
  removedFromMarketplace: boolean;
  /** Per-agent deactivation outcome (when `deactivate` was set). */
  agents?: AgentSyncResult[];
}

/**
 * Remove an installed plugin: delete its directory, drop it from
 * `.plugin-lock.json` and `marketplace.json`, and clean up any Claude
 * skills-dir symlinks that pointed at it. Only paths under `pluginsDir` (plus
 * symlinks that resolve back into it) are touched.
 *
 * Refuses when another installed plugin depends on it, unless `force` is set.
 */
export function removePlugin(opts: RemoveOptions): RemoveResult {
  const { name } = opts;
  const cwd = opts.cwd ?? process.cwd();

  const lockFile = lockPath(opts.pluginsDir);
  const lock = readLock(lockFile);

  const inLock = name in lock.plugins;
  // Locate the plugin via its recorded origin (nested for remote sources). An
  // orphan that is on disk but absent from the lock falls back to the flat path.
  const dir = inLock
    ? pluginDir(opts.pluginsDir, name, lock.plugins[name]!.origin)
    : join(opts.pluginsDir, name);
  const onDisk = existsSync(dir);
  if (!inLock && !onDisk) {
    throw new Error(`plugin "${name}" is not installed in ${opts.pluginsDir}`);
  }

  if (!opts.force) {
    const dependents = Object.entries(lock.plugins)
      .filter(([n, e]) => n !== name && e.dependencies && name in e.dependencies)
      .map(([n]) => n);
    if (dependents.length > 0) {
      throw new Error(
        `cannot remove "${name}": required by ${dependents.join(", ")}. ` +
          `Remove the dependents first or pass --force.`,
      );
    }
  }

  // Clean up Claude symlinks (created by `adg plugins link --target claude`) in
  // both global and project scopes — but only ones that resolve back to this
  // plugin's directory, so unrelated entries are never disturbed.
  const target = resolve(dir);
  const unlinked: string[] = [];
  for (const dir of [claudeSkillsDir(true, cwd), claudeSkillsDir(false, cwd)]) {
    const linkPath = join(dir, name);
    if (isSymlinkTo(linkPath, target)) {
      rmSync(linkPath);
      unlinked.push(linkPath);
    }
  }

  let removedDir: string | undefined;
  if (onDisk) {
    rmSync(dir, { recursive: true, force: true });
    removedDir = dir;
    // Drop the per-marketplace bucket if it became empty (nested remote layout).
    pruneEmptyParent(dirname(dir), opts.pluginsDir);
  }

  const removedFromLock = removeEntry(lock, name);
  if (removedFromLock) writeLock(lockFile, lock);

  const marketFile = marketplacePath(opts.pluginsDir);
  const market = readMarketplace(marketFile, basename(opts.pluginsDir));
  const removedFromMarketplace = removeMarketplacePlugin(market, name);
  if (removedFromMarketplace) writeMarketplace(marketFile, market);

  // Uninstall from the agents so we don't leave them enabled, pointing at a
  // now-deleted directory. Best-effort across all; missing CLIs are skipped.
  let agents: AgentSyncResult[] | undefined;
  if (opts.deactivate) {
    const ctx = { pluginsDir: opts.pluginsDir, plugins: [name], scope: opts.scope ?? "project" };
    agents = (opts.agents ?? resolveAgents()).map((a) => a.deactivate(ctx));
  }

  return { name, removedDir, unlinked, removedFromLock, removedFromMarketplace, agents };
}

/**
 * Remove `parent` if it is an empty per-marketplace bucket below `pluginsDir`.
 * Never touches `pluginsDir` itself (that would be the flat local layout).
 */
function pruneEmptyParent(parent: string, pluginsDir: string): void {
  if (resolve(parent) === resolve(pluginsDir)) return;
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // bucket already gone or not readable — nothing to prune
  }
}

function isSymlinkTo(linkPath: string, target: string): boolean {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    // readlinkSync may return a path relative to the link's own directory; resolve
    // it there (resolve ignores the base when the target is already absolute).
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(target);
  } catch {
    return false;
  }
}
