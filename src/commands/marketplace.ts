import type { AdapterTarget } from "../adapters/index.ts";
import type { GitRunner } from "../sources.ts";
import type { PluginSource } from "../types.ts";
import { lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { addPlugins } from "./install.ts";
import { removePlugin } from "./remove.ts";
import { syncPlugins, type SyncResult } from "./sync.ts";
import { updateLock, type UpdateLockResult } from "./update.ts";
import type { Agent, AgentScope, AgentSyncResult } from "../agents/index.ts";

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

/** Per-source outcome of `updatePlugins` (the network "check + update" pass). */
export interface PluginUpdateSourceResult {
  source: string;
  ref?: string;
  /** Plugin names whose content/version changed upstream and were refreshed. */
  updated: string[];
  /** Re-fetched but byte-identical to what was installed. */
  unchanged: string[];
  /** Installed locally but no longer present in the source (deleted upstream). */
  deleted: string[];
  /** Discovered in the source but not installed (offered for `--all`). */
  available: string[];
  /** Set when the source could not be fetched; the message explains why. */
  failed?: string;
}

export interface PluginUpdateResult {
  /** One entry per remote source that was checked. */
  remote: PluginUpdateSourceResult[];
  /** In-place rescan of local-source / disk-edited plugins (no network). */
  local: UpdateLockResult;
  /**
   * Consolidated per-agent re-sync outcome across BOTH the remote re-fetches and
   * the local rescan, deduplicated by agent. Empty when `activate` was off or
   * nothing changed. The CLI renders this so remote re-activations are reported,
   * not just local ones.
   */
  agents: AgentSyncResult[];
}

/** Merge per-agent sync results from several passes into one entry per agent. */
export function mergeAgentResults(groups: AgentSyncResult[][]): AgentSyncResult[] {
  const merged = new Map<string, AgentSyncResult>();
  for (const r of groups.flat()) {
    const existing = merged.get(r.agent);
    if (existing) {
      existing.affected = [...new Set([...existing.affected, ...r.affected])];
      // Skipped only when EVERY pass skipped the agent (CLI absent throughout).
      // If any pass ran, the agent was processed — matches addPlugins' merge so
      // a skipped local rescan can't mask a successful remote re-activation.
      existing.skipped = existing.skipped && r.skipped;
    } else {
      merged.set(r.agent, { ...r, affected: [...r.affected] });
    }
  }
  return [...merged.values()];
}

/**
 * The plugins-domain equivalent of `adg skills update`: re-fetch every remote
 * source (or one named `source`), report which installed plugins changed,
 * stayed the same, were deleted upstream, or are newly available, and refresh
 * local-source plugins in place. Failures are recorded per-source rather than
 * aborting the whole pass, so one unreachable repo doesn't hide the rest.
 */
export async function updatePlugins(
  opts: MarketplaceScope & {
    source?: string;
    all?: boolean;
    targets?: AdapterTarget[];
    gitRunner?: GitRunner;
    /** Re-activate the agents after updating (set by the CLI; off by default). */
    activate?: boolean;
    /** Install scope for re-activation / local rescan. */
    agentScope?: AgentScope;
    /** Injection seam for tests; forwarded to the install + local-rescan steps. */
    agents?: Agent[];
    /** Injection seam for removed remote entries; defaults to every registered agent. */
    deactivationAgents?: Agent[];
  },
): Promise<PluginUpdateResult> {
  const allGroups = marketplaceList({ pluginsDir: opts.pluginsDir });

  // A named source narrows to just that group (and must be remote); otherwise we
  // refresh every remote source and rescan the local bucket.
  const remoteGroups = opts.source
    ? [requireGroup(opts.pluginsDir, opts.source, opts.scope)]
    : allGroups.filter((g) => g.remote);

  if (opts.source && !remoteGroups[0]!.remote) {
    throw new Error(`source "${opts.source}" is local and cannot be re-synced; re-run \`adg plugins add\`.`);
  }

  const now = opts.now ?? new Date().toISOString();
  const remote: PluginUpdateSourceResult[] = [];
  const remoteAgents: AgentSyncResult[] = [];

  for (const group of remoteGroups) {
    try {
      const { installed, available, agents } = await addPlugins({
        spec: group.source,
        pluginsDir: opts.pluginsDir,
        ref: group.ref,
        // Default: refresh what's installed. --all: also install anything new.
        ...(opts.all ? { all: true } : { plugins: group.installed }),
        missingPlugins: "skip", // an upstream deletion is reported, not fatal
        skipUnchanged: true, // detect-then-update: leave unchanged plugins alone
        targets: opts.targets,
        marketplaceName: group.source,
        gitRunner: opts.gitRunner,
        activate: opts.activate,
        scope: opts.agentScope,
        agents: opts.agents,
        deactivationAgents: opts.deactivationAgents,
        now,
      });
      if (agents) remoteAgents.push(...agents);
      const availableSet = new Set(available);
      const installedNow = new Set(installed.map((r) => r.name));
      remote.push({
        source: group.source,
        ...(group.ref ? { ref: group.ref } : {}),
        updated: installed.filter((r) => r.changed).map((r) => r.name).sort(),
        unchanged: installed.filter((r) => !r.changed).map((r) => r.name).sort(),
        deleted: group.installed.filter((n) => !availableSet.has(n)).sort(),
        available: available.filter((n) => !installedNow.has(n) && !group.installed.includes(n)).sort(),
      });
    } catch (err) {
      remote.push({
        source: group.source,
        ...(group.ref ? { ref: group.ref } : {}),
        updated: [],
        unchanged: [],
        deleted: [],
        available: [],
        failed: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Local-source / disk-edited plugins can't be re-fetched, but a rescan still
  // refreshes their lock/manifests/agents. Only run it on a full pass (no named
  // source) and only for the local bucket — remote ones were just re-fetched.
  const localNames = opts.source ? [] : (allGroups.find((g) => !g.remote)?.installed ?? []);
  const local: UpdateLockResult = localNames.length
    ? updateLock(opts.pluginsDir, now, { only: localNames, resync: opts.activate, scope: opts.agentScope, agents: opts.agents })
    : { results: [], missing: [] };

  const agents = mergeAgentResults([remoteAgents, local.agents ?? []]);
  return { remote, local, agents };
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

/**
 * Reconcile one agent's copy of every plugin from a given source to the store —
 * the source-scoped twin of `adg plugins sync`. Resolves the source's installed
 * plugins from the lock, then drives `syncPlugins` for just that set, so a whole
 * marketplace can be repaired in one call without naming each plugin.
 */
export function marketplaceSync(
  opts: MarketplaceScope & { source: string; target: AdapterTarget; global?: boolean; agent?: Agent },
): SyncResult {
  const group = requireGroup(opts.pluginsDir, opts.source, opts.scope);
  return syncPlugins({
    pluginsDir: opts.pluginsDir,
    target: opts.target,
    global: opts.global,
    names: group.installed,
    agent: opts.agent,
  });
}
