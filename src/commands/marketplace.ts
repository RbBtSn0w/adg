import { upgradeSource, publishUpgradeTransaction, UpdateCancelled, type ReviewUpdate } from "./source-upgrade.ts";
import { ADAPTER_TARGETS } from "../adapters/index.ts";
import { sourceIntent } from "../source-intent.ts";
import { replayNativeRetries, syncNativeWithRetry } from "../native-retry.ts";
import { discoverPendingMigrations, type MigrationPublishResult } from "../migration-transaction.ts";
import { repairCodex } from "./runtime-repair.ts";
import { getAgent, resolveAgents } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";
import { type GitRunner } from "../sources.ts";
import { cloneGitHub, gitRevision, parseGitHubSource } from "../sources.ts";
import { materializeSource, resolveRemoteRevision } from "../remote/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginSource } from "../types.ts";
import { lockPath } from "../paths.ts";
import { readLock, writeLock } from "../lock.ts";
import { removePlugin } from "./remove.ts";
import { syncPlugins, type SyncResult } from "./sync.ts";
import { updateLock, type UpdateLockResult } from "./update.ts";
import type { Agent, AgentScope, AgentSyncResult } from "../agents/index.ts";
import type { UpdatePhase } from "../render/progress.ts";
import type { PluginChanges } from "../plugin-changes.ts";
import type { Span } from "@opentelemetry/api";
import { recordTelemetryEvent } from "../telemetry.ts";

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
  /** Working directory to resolve relative paths against; defaults to process.cwd(). */
  cwd?: string;
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

  for (const intent of lock.sources ?? []) {
    if ((intent.mode === "all" || intent.deferredRecovery?.length) && !groups.has(intent.source)) groups.set(intent.source, {ref:intent.ref, installed:[]});
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
    let inGlobal = false;
    try {
      inGlobal = marketplaceList({ pluginsDir: scope.globalDir }).some((g) => g.source === source);
    } catch {
      // The global store is only an optional suggestion source. A malformed or
      // unsupported global lock must not mask the active scope's real error.
    }
    if (inGlobal) msg += ` — found in global; did you mean \`-g\`?`;
  }
  throw new Error(msg);
}

/** Per-source outcome of `updatePlugins` (the network "check + update" pass). */
export interface PluginUpdateSourceResult {
  source: string;
  ref?: string;
  /** Plugin names whose source/store records changed; not runtime success. */
  updated: string[];
  /** Re-fetched but byte-identical to what was installed. */
  unchanged: string[];
  /** Plugins actually uninstalled; retained for report compatibility. Updates do not uninstall. */
  deleted: string[];
  /** Installed plugins absent upstream, retained with their last verified payload and state. */
  missingUpstream?: string[];
  /** Discovered in the source but not installed (offered for `--all`). */
  available: string[];
  /** Source/store changes; runtime sync outcomes are reported separately in agents. */
  changes?: Array<PluginChanges & { name: string; runtimeRefreshRequired: boolean }>;
  /** Set when the source could not be fetched; the message explains why. */
  failed?: string;
  migrated?: string[];
  resumed?: boolean;
  actionRequired?: string[];
  pendingRuntime?: string[];
  notRestored?: string[];
  /** Unknown historical candidates deferred without authorizing installation. */
  deferredRecovery?: string[];
  restored?: string[];
  retained?: string[];
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
      if (r.failures?.length) existing.failures = [...(existing.failures ?? []), ...r.failures];
      for (const field of ["verified", "unverified", "preservedDisabled"] as const) {
        if (r[field] !== undefined) existing[field] = [...new Set([...(existing[field] ?? []), ...r[field]!])];
      }
    } else {
      merged.set(r.agent, { ...r, affected: [...r.affected] });
    }
  }
  return [...merged.values()];
}

/**
 * The plugins-domain equivalent of `adg skills update`: re-fetch every remote
 * source (or one named `source`), report which installed plugins changed,
 * stayed the same, are missing upstream, or are newly available, and refresh
 * local-source plugins in place. Failures are recorded per-source rather than
 * aborting the whole pass, so one unreachable repo doesn't hide the rest.
 */
export async function updatePlugins(
  opts: MarketplaceScope & {
    source?: string;
    review?: ReviewUpdate;
    all?: boolean;
    targets?: AdapterTarget[];
    gitRunner?: GitRunner;
    /** Re-activate the agents after updating (set by the CLI; off by default). */
    activate?: boolean;
    repair?: boolean;
    /** Install scope for re-activation / local rescan. */
    agentScope?: AgentScope;
    /** Injection seam for tests; forwarded to the install + local-rescan steps. */
    agents?: Agent[];
    /** Injection seam for removed remote entries; defaults to every registered agent. */
    deactivationAgents?: Agent[];
    /** Injectable revision probe. The standard GitHub transport probes by default. */
    revisionResolver?: (source: string, ref?: string) => string | undefined | Promise<string | undefined>;
    telemetrySpan?: Pick<Span, "addEvent">;
    /**
     * Progress sink for the phases that actually cost time: one blocking
     * probe per source, a materialize/clone when the revision moved, the per-request
     * installs, and the local rescan. Forwarded into `addPlugins` so agent
     * re-activation reports too. Emitting only — printing is the CLI's job.
     */
    onProgress?: (phase: UpdatePhase) => void;
  },
): Promise<PluginUpdateResult> {
  const executionProviders = opts.activate ? opts.agents ?? [...new Map([
    ...resolveAgents(opts.targets), ...(opts.repair ? resolveAgents(["codex"]) : []),
  ].map(agent => [agent.id, agent])).values()] : [];
  // Replay pending operations before probing any remote revision.
  const pending = discoverPendingMigrations(opts.pluginsDir).filter(item => !opts.source || item.source === opts.source);
  const remote: PluginUpdateSourceResult[] = [];
  const resumedAgents: AgentSyncResult[] = [];
  const managedByMigration = new Set<string>();
  const rememberManagedNative = (targets: NonNullable<MigrationPublishResult["managedNative"]>) => {
    for (const target of targets) if (target.agent === "codex") for (const name of target.plugins) managedByMigration.add(name);
  };
  for (const item of pending) {
    let resumed: MigrationPublishResult;
    try {
      resumed = await publishUpgradeTransaction(item.journalPath, executionProviders, item.source, opts.review, item.ref, opts.repair ? ["codex"] : undefined);
    } catch (error) {
      if (error instanceof UpdateCancelled) {
        error.partial = { remote: [...remote, ...(error.partial?.remote ?? [])], local: { results: [], missing: [] },
          agents: [...resumedAgents, ...(error.partial?.agents ?? [])] };
      }
      throw error;
    }
    resumedAgents.push(...(resumed.agents ?? []));
    rememberManagedNative(resumed.managedNative ?? []);
    remote.push({
      source: item.source, ref: item.ref, updated: [], unchanged: [], deleted: [], available: [],
      ...(resumed.complete ? { resumed: true } : { pendingRuntime: resumed.failures.map(failure => failure.message) }),
    });
  }
  const recovered = await replayNativeRetries({
    pluginsDir: opts.pluginsDir, source: opts.source, agents: executionProviders,
    onProgress: opts.onProgress,
  });
  for (const group of recovered.groups) {
    const failures = recovered.pending.filter(item => item.source === group.source && item.ref === group.ref);
    remote.push({ ...group, updated: [], unchanged: [], deleted: [], available: [],
      ...(failures.length ? { pendingRuntime: failures.map(item => item.message) } : { resumed: true }) });
  }
  const allGroups = marketplaceList({ pluginsDir: opts.pluginsDir });

  // A named source narrows to just that group (and must be remote); otherwise we
  // refresh every remote source and rescan the local bucket.
  const selectedGroups = opts.source
    ? (remote.some(group => group.source === opts.source) ? allGroups.filter(group => group.source === opts.source)
      : [requireGroup(opts.pluginsDir, opts.source, opts.scope)])
    : allGroups.filter((g) => g.remote);

  if (opts.source && selectedGroups[0]?.remote === false) {
    throw new Error(`source "${opts.source}" is local and cannot be re-synced; re-run \`adg plugins add\`.`);
  }

  // The marketplace view aggregates a repository for list/remove/sync. Update
  // must fetch each ref independently so one plugin cannot move a sibling's
  // pin or make it appear absent at the wrong revision.
  const initialLock = readLock(lockPath(opts.pluginsDir));
  const remoteGroups = selectedGroups.flatMap((group) => {
    const refs = new Map<string | undefined, MarketplaceGroup>();
    for (const name of group.installed) {
      const origin = initialLock.plugins[name]!.origin;
      const ref = origin.type === "local" ? undefined : origin.ref;
      const member = refs.get(ref) ?? { source: group.source, ...(ref ? { ref } : {}), installed: [], remote: true };
      member.installed.push(name);
      refs.set(ref, member);
    }
    for (const intent of initialLock.sources ?? []) {
      if (intent.source === group.source && (intent.mode === "all" || intent.deferredRecovery?.length) && !refs.has(intent.ref)) {
        refs.set(intent.ref, {source:group.source,ref:intent.ref,installed:[],remote:true});
      }
    }
    return [...refs.values()].filter(group => !remote.some(item => item.source === group.source && item.ref === group.ref));
  });

  const repairAgent = opts.agents
    ? opts.agents.find((agent) => agent.id === "codex") ?? null
    : getAgent("codex");
  const repairScope = opts.agentScope ?? "project";
  const initial = opts.repair ? repairAgent?.inspectPlugins?.({ pluginsDir: opts.pluginsDir, plugins: [], scope: repairScope }) : undefined;
  // Source materialization proceeds, but this mode owns every Codex mutation.
  const updateAgents = opts.repair ? (opts.agents ?? resolveAgents(opts.targets)).filter((agent) => agent.id !== "codex") : opts.agents;
  const now = opts.now ?? new Date().toISOString();
  const remoteAgents: AgentSyncResult[] = [...resumedAgents, ...recovered.agents];

  let sourceIndex = 0;
  for (const group of remoteGroups) {
    const position = { index: ++sourceIndex, total: remoteGroups.length };
    try {
      opts.onProgress?.({ kind: "check", ...position, source: group.source });
      const lock = readLock(lockPath(opts.pluginsDir));
      const policy = sourceIntent(lock, group.source, group.ref);
      const targets = opts.targets ?? policy?.targets?.filter((id): id is AdapterTarget => ADAPTER_TARGETS.includes(id as AdapterTarget));
      const runtime = opts.activate ? opts.agents ?? resolveAgents(targets) : [];
      const refreshExisting = runtime.flatMap(agent => {
        if (!agent.needsProjectionRefresh || !agent.detect()) return [];
        const names = group.installed.filter(name => lock.plugins[name]?.state !== "disabled");
        return agent.needsProjectionRefresh({ pluginsDir: opts.pluginsDir, scope: repairScope, plugins: names })
          .map(name => ({ name, target: agent.id }));
      });
      const refreshProjections = async (unchanged: string[]) => {
        for (const agent of runtime) {
          const refresh = refreshExisting.filter(item => item.target === agent.id && unchanged.includes(item.name)).map(item => item.name);
          if (refresh.length) remoteAgents.push(await syncNativeWithRetry({
            pluginsDir: opts.pluginsDir, scope: repairScope, agent, activate: [], refresh, preserveRuntimeDisabled: true,
          }));
        }
      };
      const revisions = group.installed.map((name) => policy?.retained?.includes(name) ? policy.retainedAtRevision : lock.plugins[name]?.resolvedRevision).filter((revision): revision is string => Boolean(revision));
      // A supplied transport owns its checkout, including offline fixtures.
      const probe = opts.revisionResolver ?? (opts.gitRunner ? undefined : resolveRemoteRevision);
      const remoteRevision = await probe?.(group.source, group.ref);
      if (!opts.all && !(opts.repair && policy?.deferredRecovery?.length) && revisions.length > 0 && remoteRevision && revisions.length === group.installed.length && revisions.every((revision) => revision === remoteRevision)) {
        await refreshProjections(group.installed);
        remote.push({ source: group.source, ...(group.ref ? { ref: group.ref } : {}), updated: [], unchanged: group.installed.filter(name => !policy?.retained?.includes(name)).sort(), retained: policy?.retained, deleted: [], available: [],
          ...(policy?.deferredRecovery?.length ? { deferredRecovery: [...new Set(policy.deferredRecovery.flatMap(item => item.skills))].sort() } : {}) });
        continue;
      }
      const checkout = mkdtempSync(join(tmpdir(), "adg-marketplace-update-"));
      try {
        const parsed = parseGitHubSource(group.source);
        opts.onProgress?.({ kind: "fetch", ...position, source: group.source, ...(group.ref ? { ref: group.ref } : {}) });
        const mat = await materializeSource({ ...parsed, ref: group.ref }, checkout, {
          runner: opts.gitRunner,
          resolvedRevision: remoteRevision,
          // A complete source catalog is required to distinguish relocation
          // from deletion, including siblings outside an earlier sparse add.
        });
        const resolvedRevision = mat.resolvedRevision ?? gitRevision(checkout);
        const result = await upgradeSource({
          group, checkout, revision: resolvedRevision, pluginsDir: opts.pluginsDir,
          all: opts.all, repair: opts.repair, activate: opts.activate, scope: repairScope, agents: opts.agents,
          targets: opts.targets, now, review: opts.review, refreshExisting,
          gitRunner: opts.gitRunner, onProgress: opts.onProgress,
          onAgentResults: results => remoteAgents.push(...results),
          onNativeManaged: rememberManagedNative,
        });
        remote.push(result);
        if (result.deferredRecovery?.length) recordTelemetryEvent("adg.plugins.update.recovery_deferred", {
          "skills.count": result.deferredRecovery.length,
        }, opts.telemetrySpan);
        if (result.missingUpstream?.length) recordTelemetryEvent("adg.plugins.update.missing_upstream", {
          "plugins.retained": result.missingUpstream.length,
          "update.include_new": Boolean(opts.all),
        }, opts.telemetrySpan);
        else recordTelemetryEvent("adg.plugins.update.migration", {
          "migration.count": result.migrated?.length ?? 0,
          "action_required.count": result.actionRequired?.length ?? 0,
          "pending.count": result.pendingRuntime?.length ?? 0,
          "plugins.retained": result.missingUpstream?.length ?? 0,
        }, opts.telemetrySpan);
      } finally { rmSync(checkout, { recursive: true, force: true }); }
    } catch (err) {
      if (err instanceof UpdateCancelled) {
        err.partial = { remote: [...remote, ...(err.partial?.remote ?? [])], local: { results: [], missing: [] },
          agents: [...remoteAgents, ...(err.partial?.agents ?? [])] };
        throw err;
      }
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
    ? updateLock(opts.pluginsDir, now, {
        only: localNames,
        resync: opts.activate,
        scope: opts.agentScope,
        agents: updateAgents,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      })
    : { results: [], missing: [] };

  const repairNames = [...new Set([...selectedGroups.flatMap((group) => group.installed), ...remote.flatMap((source) => [...source.updated, ...source.unchanged]), ...localNames])].filter(name => !managedByMigration.has(name));
  const currentLock = readLock(lockPath(opts.pluginsDir));
  const repairs = opts.activate && opts.repair && repairNames.length ? [repairCodex({
    pluginsDir: opts.pluginsDir, plugins: repairNames.filter(name => currentLock.plugins[name]), scope: repairScope,
  }, false, repairAgent, {
    initial, observed: true,
    changed: [...remote.flatMap(source => source.changes
      ? source.changes.filter(plugin => plugin.runtimeRefreshRequired).map(plugin => plugin.name)
      : source.updated), ...local.results.filter(plugin => plugin.runtimeRefreshRequired ?? plugin.changed).map(plugin => plugin.name)],
    removed: repairNames.filter(name => !currentLock.plugins[name]),
  })] : [];
  const agents = mergeAgentResults([remoteAgents, local.agents ?? [], repairs]);
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
  const file = lockPath(opts.pluginsDir);
  const lock = readLock(file);
  if (lock.sources?.some(intent => intent.source === opts.source)) {
    lock.sources = lock.sources.filter(intent => intent.source !== opts.source);
    writeLock(file, lock);
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
