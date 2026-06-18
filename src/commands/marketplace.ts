import type { AdapterTarget } from "../adapters/index.ts";
import type { GitRunner } from "../sources.ts";
import type { PluginSource } from "../types.ts";
import { lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { addPlugins, type InstallResult } from "./install.ts";
import { removePlugin } from "./remove.ts";
import type { AgentScope } from "../agents/index.ts";

/**
 * The marketplace layer is a *view* over installed plugins grouped by their
 * source, not a separate registry. Every plugin records where it came from in
 * `lock.origin`; a "marketplace" is just the set of plugins sharing a source.
 */

/** Active-scope context, used to make "source not found" errors actionable. */
export interface ScopeInfo {
  /** Human label for the active scope: "project", "global", or an explicit dir. */
  label: string;
  /** The global plugins dir, so we can suggest `-g` when a source is only there. */
  globalDir?: string;
}

export interface MarketplaceScope {
  pluginsDir: string;
  now?: string;
  /** Where the active pluginsDir came from, for scope-aware error messages. */
  scope?: ScopeInfo;
}

/**
 * A stable key identifying the source a plugin came from. GitHub/git plugins
 * group by repo/url (the marketplace root, ignoring per-plugin sub-paths);
 * local installs share a single "(local)" bucket since their original source
 * directory isn't recoverable for re-sync.
 */
export function sourceKey(origin: PluginSource): string {
  switch (origin.type) {
    case "github":
      return origin.repo;
    case "git":
      return origin.url;
    case "local":
      return "(local)";
  }
}

/** True for sources that can be re-fetched (have a recoverable remote spec). */
function isRemoteKey(key: string): boolean {
  return key !== "(local)";
}

export interface MarketplaceGroup {
  /** Source key (owner/repo, git url, or "(local)"). */
  source: string;
  /** ref shared by the group's plugins, if any. */
  ref?: string;
  /** Installed plugin names from this source. */
  installed: string[];
  /** Whether this source can be re-synced (remote). */
  remote: boolean;
}

/** Group installed plugins by source, read straight from the lock. */
export function marketplaceList(opts: { pluginsDir: string }): MarketplaceGroup[] {
  const lock = readLock(lockPath(opts.pluginsDir));
  const groups = new Map<string, { ref?: string; installed: string[] }>();

  for (const [name, entry] of Object.entries(lock.plugins)) {
    const key = sourceKey(entry.origin);
    const ref = entry.origin.type === "github" || entry.origin.type === "git" ? entry.origin.ref : undefined;
    const g = groups.get(key) ?? { ref, installed: [] };
    g.installed.push(name);
    if (g.ref === undefined && ref !== undefined) g.ref = ref;
    groups.set(key, g);
  }

  return [...groups.entries()]
    .map(([source, g]) => ({
      source,
      ...(g.ref ? { ref: g.ref } : {}),
      installed: g.installed.sort(),
      remote: isRemoteKey(source),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Find one source group by key, or throw with the available keys. The error is
 * scope-aware: it names the scope/path it searched, and — when the source isn't
 * here but exists globally — suggests re-running with `-g`.
 */
function requireGroup(pluginsDir: string, source: string, scope?: ScopeInfo): MarketplaceGroup {
  const groups = marketplaceList({ pluginsDir });
  const hit = groups.find((g) => g.source === source);
  if (hit) return hit;

  const keys = groups.map((g) => g.source).join(", ") || "(none)";
  const where = scope?.label ? `${scope.label}: ${pluginsDir}` : pluginsDir;
  let msg = `no installed source "${source}" in ${where}. Known sources: ${keys}`;

  if (scope?.globalDir && scope.globalDir !== pluginsDir) {
    const inGlobal = marketplaceList({ pluginsDir: scope.globalDir }).some((g) => g.source === source);
    if (inGlobal) msg += ` — found in global; did you mean \`-g\`?`;
  }
  throw new Error(msg);
}

export interface MarketplaceUpgradeResult {
  source: string;
  /** Plugins re-installed/updated from the source. */
  updated: InstallResult[];
  converted: string[];
  /** Discovered in the source but not installed (offered for `--all`). */
  available: string[];
}

/**
 * Re-fetch a source and update the plugins installed from it. By default only
 * already-installed plugins are refreshed; `all` also installs everything new
 * the source now offers. With no `source`, every remote source is upgraded.
 */
export async function marketplaceUpgrade(
  opts: MarketplaceScope & {
    source?: string;
    all?: boolean;
    targets?: AdapterTarget[];
    gitRunner?: GitRunner;
    /** Re-activate the agents after upgrade (set by the CLI; off by default). */
    activate?: boolean;
    /** Install scope for re-activation after upgrade. */
    agentScope?: AgentScope;
  },
): Promise<MarketplaceUpgradeResult[]> {
  const groups = opts.source
    ? [requireGroup(opts.pluginsDir, opts.source, opts.scope)]
    : marketplaceList({ pluginsDir: opts.pluginsDir }).filter((g) => g.remote);

  if (opts.source && !groups[0]!.remote) {
    throw new Error(`source "${opts.source}" is local and cannot be re-synced; re-run \`adg plugins add\`.`);
  }
  if (groups.length === 0) {
    throw new Error(`no remote sources installed in ${opts.pluginsDir}`);
  }

  const now = opts.now ?? new Date().toISOString();
  const results: MarketplaceUpgradeResult[] = [];

  for (const group of groups) {
    const { installed, converted, available } = await addPlugins({
      spec: group.source,
      pluginsDir: opts.pluginsDir,
      ref: group.ref,
      // Default: refresh what's installed. --all: install everything too.
      ...(opts.all ? { all: true } : { plugins: group.installed }),
      targets: opts.targets,
      marketplaceName: group.source,
      gitRunner: opts.gitRunner,
      // Re-activate so the agents pick up the upgraded content, not just the store.
      activate: opts.activate,
      scope: opts.agentScope,
      now,
    });
    const installedSet = new Set(group.installed);
    results.push({
      source: group.source,
      updated: installed,
      converted,
      available: available.filter((n) => !installedSet.has(n)),
    });
  }

  return results;
}

export interface MarketplaceRemoveResult {
  source: string;
  removed: string[];
}

/** Uninstall every plugin that came from a given source (and from the agents). */
export function marketplaceRemove(
  opts: MarketplaceScope & { source: string; force?: boolean; deactivate?: boolean; agentScope?: AgentScope },
): MarketplaceRemoveResult {
  const group = requireGroup(opts.pluginsDir, opts.source, opts.scope);
  const removed: string[] = [];
  for (const name of group.installed) {
    removePlugin({
      pluginsDir: opts.pluginsDir,
      name,
      force: opts.force,
      deactivate: opts.deactivate,
      scope: opts.agentScope,
    });
    removed.push(name);
  }
  return { source: opts.source, removed };
}
