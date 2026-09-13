import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AdapterTarget } from "../adapters/index.ts";
import { toPosix } from "../fsutil.ts";
import { lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { resolveInstallOrder } from "../deps.ts";
import { cloneGitHub, gitRevision, parseGitHubSource, parseSource, type ParsedSource } from "../sources.ts";
import { pluginState, type DefaultDefinitionProfile, type PluginSource } from "../types.ts";
import { resolveAgents, type AgentSyncResult } from "../agents/index.ts";
import { installPlugin } from "./install/install-one.ts";
import { discoverPlugins, reconcileRemotePlugins, resolveSelections, selectPluginNames } from "./install/discovery.ts";
import { synthesizeDefaultDslPlugin } from "./install/default-dsl.ts";
import type { AddOptions, AddResult, InstallResult } from "./install/types.ts";

export { installPlugin, contentHash } from "./install/install-one.ts";
export type {
  InstallOneOptions,
  InstallResult,
  ResolvedInstallOrder,
  PluginChoice,
  SelectComponentsRequest,
  AddOptions,
  AddResult,
} from "./install/types.ts";

interface PreparedSource {
  workRoot: string;
  /** `dir` is the candidate's directory; `dirOverride` re-points origin at a synthesized plugin's real source (see synthesizeDefaultDslPlugin). */
  buildOrigin: (dir: string, dirOverride?: string) => PluginSource;
  resolvedRevision: string | undefined;
  cleanup: (() => void) | undefined;
}

/**
 * Resolve `opts.spec` to a local working directory plus an origin builder and
 * cleanup, covering the three source kinds: a prepared checkout (remote
 * marketplace update, already on disk), a local directory (no clone, no
 * cleanup), or a GitHub source (clone to a temp dir, cleaned up by the caller).
 */
function prepareSource(
  opts: AddOptions,
  parsed: ParsedSource,
  sourceRef: string | undefined,
): PreparedSource {
  if (opts.preparedSourceDir) {
    const workRoot = resolve(opts.preparedSourceDir);
    return {
      workRoot,
      resolvedRevision: opts.preparedResolvedRevision,
      buildOrigin: (dir, dirOverride) => ({
        type: "github",
        repo: parsed.kind === "github" ? parsed.source : opts.spec,
        ...(sourceRef ? { ref: sourceRef } : {}),
        path: toPosix(relative(workRoot, dirOverride ?? dir)) || ".",
      }),
      cleanup: undefined,
    };
  }
  if (parsed.kind === "local") {
    const workRoot = resolve(parsed.dir);
    return {
      workRoot,
      resolvedRevision: undefined,
      buildOrigin: (dir, dirOverride) => ({ type: "local", path: resolve(dirOverride ?? dir) }),
      cleanup: undefined,
    };
  }
  const tmp = mkdtempSync(join(tmpdir(), "adg-clone-"));
  try {
    cloneGitHub({ ...parsed, ref: sourceRef }, tmp, { sparse: opts.sparse, runner: opts.gitRunner });
    const resolvedRevision = gitRevision(tmp);
    return {
      workRoot: tmp,
      resolvedRevision,
      buildOrigin: (dir, dirOverride) => ({
        type: "github",
        repo: parsed.source,
        ...(sourceRef ? { ref: sourceRef } : {}),
        path: toPosix(relative(tmp, dirOverride ?? dir)) || ".",
      }),
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function activateInstalled(
  opts: AddOptions,
  targets: AdapterTarget[] | undefined,
  installed: InstallResult[],
  existingPlugins: Set<string>,
): AgentSyncResult[] | undefined {
  const updatedLock = readLock(lockPath(opts.pluginsDir));
  const eligible = installed.filter((result) => pluginState(updatedLock.plugins[result.name]!) === "enabled");
  const toActivate = opts.skipUnchanged ? eligible.filter((result) => result.changed) : eligible;
  if (!opts.activate || toActivate.length === 0) return undefined;

  const resolved = opts.agents ?? resolveAgents(targets);
  const scope = opts.scope ?? "project";
  const ctxFor = (names: string[]) => ({ pluginsDir: opts.pluginsDir, plugins: names, scope });

  return resolved.map((agent) => {
    opts.onProgress?.({ kind: "activate", agent: agent.id, count: toActivate.length });
    const queryResult = agent.listInstalled?.(ctxFor([]));
    const agentInstalled = Array.isArray(queryResult) ? queryResult : undefined;
    const alreadyInstalled = (name: string) =>
      agentInstalled !== undefined
        ? agentInstalled.includes(name)
        : existingPlugins.has(name);
    const activateNames = toActivate.filter((result) => !alreadyInstalled(result.name)).map((result) => result.name);
    const refreshNames = toActivate.filter((result) => alreadyInstalled(result.name)).map((result) => result.name);
    const parts: AgentSyncResult[] = [];
    if (activateNames.length > 0) parts.push(agent.activate(ctxFor(activateNames)));
    if (refreshNames.length > 0) parts.push(agent.refresh(ctxFor(refreshNames)));
    return parts.reduce<AgentSyncResult>(
      (acc, result) => ({ agent: result.agent, affected: [...acc.affected, ...result.affected], skipped: acc.skipped && result.skipped }),
      { agent: agent.id, affected: [], skipped: true },
    );
  });
}

/**
 * The unified install entrypoint. Treats any source as a marketplace: clone or
 * read it, discover every plugin (ADG plus reverse-adapted native), choose a
 * subset (--all / --plugin / sole plugin / interactive picker), then
 * install the selection in dependency-first order.
 */
export async function addPlugins(opts: AddOptions): Promise<AddResult> {
  // Prepared checkouts are used only by remote marketplace update. Parse their
  // persisted owner/repo key as GitHub even when the caller's CWD shadows it.
  const parsed = opts.preparedSourceDir ? parseGitHubSource(opts.spec) : parseSource(opts.spec, opts.cwd);
  const sourceRef = parsed.kind === "local" ? undefined : (opts.ref ?? parsed.ref);
  if (parsed.kind === "github" && parsed.path) {
    throw new Error("GitHub subdirectory sources are not supported; define a marketplace and select with --plugin or --all");
  }
  const prepared = prepareSource(opts, parsed, sourceRef);
  const { workRoot, buildOrigin, resolvedRevision } = prepared;
  let cleanup = prepared.cleanup;
  let originDirOverride: string | undefined;
  let definition: DefaultDefinitionProfile | undefined;
  let structuralName: string | undefined;

  try {
    let { candidates, converted } = discoverPlugins(workRoot);
    const existingLock = readLock(lockPath(opts.pluginsDir));
    if (candidates.size > 0) {
      if (opts.structuralIdentity && !candidates.has(opts.structuralIdentity)) {
        throw new Error(
          `source definition changed from Default DSL to explicit plugin(s), but none match the installed identity "${opts.structuralIdentity}"; re-add or migrate the plugin explicitly`,
        );
      }
      if (opts.as && !opts.structuralIdentity) {
        throw new Error("--as is only supported for a default structural plugin source");
      }
    }
    if (candidates.size === 0) {
      const synthesized = await synthesizeDefaultDslPlugin(opts, parsed, workRoot, resolvedRevision);
      candidates = synthesized.candidates;
      converted = synthesized.converted;
      structuralName = synthesized.structuralName;
      originDirOverride = synthesized.originDirOverride;
      definition = synthesized.definition;
      const priorCleanup = cleanup;
      cleanup = () => {
        try {
          synthesized.cleanup();
        } finally {
          priorCleanup?.();
        }
      };
    }

    const selected = structuralName ? [structuralName] : await selectPluginNames(opts, candidates, converted);

    // Resolve adapter targets after the plugin choice (lets a CLI agent picker
    // run once we know what's being installed). undefined → installPlugin's all.
    const targets = opts.targets ?? (opts.selectTargets ? await opts.selectTargets() : undefined);
    const available = [...candidates.keys()];

    if (selected.length === 0) {
      // Under "skip" (the update path) every requested plugin was deleted
      // upstream: don't abort — return what the source still offers so the
      // caller can report the deletions.
      if (opts.missingPlugins === "skip") {
        const removed = reconcileRemotePlugins(opts, parsed, sourceRef, new Set(selected));
        return { order: [], installed: [], removed, converted, available };
      }
      throw new Error("no plugins selected");
    }

    // Partial-install selection per user-chosen plugin (auto-deps install full).
    const selections = await resolveSelections(opts, selected, candidates);
    if (definition && structuralName) {
      definition = {
        ...definition,
        authorizedComponents: selections.get(structuralName)?.components ?? definition.authorizedComponents,
      };
    }

    // Dependency-first order across every selected plugin (chains deduped).
    const order: string[] = [];
    const seen = new Set<string>();
    for (const name of selected) {
      const chain = opts.withDeps === false ? [name] : resolveInstallOrder(name, candidates);
      for (const n of chain) {
        if (!seen.has(n)) {
          seen.add(n);
          order.push(n);
        }
      }
    }
    // A generated Default DSL replay retains its definition profile. Only an
    // explicit manifest discovered from the source may replace that profile.
    const definitionSwitches = definition
      ? []
      : order.filter((name) => existingLock.plugins[name]?.definition && name !== opts.structuralIdentity);
    if (definitionSwitches.length > 0) {
      const names = definitionSwitches.sort().map((name) => `"${name}"`).join(", ");
      throw new Error(`source definition changed from default DSL to a manifest for ${names}; re-add or migrate the plugin explicitly`);
    }
    const removed = reconcileRemotePlugins(opts, parsed, sourceRef, new Set(order));

    // Snapshot which plugins already existed before this call mutates the lock,
    // so the activation step below can tell brand-new installs from updates.
    const existingPlugins = new Set(Object.keys(readLock(lockPath(opts.pluginsDir)).plugins));

    const installed: InstallResult[] = [];
    for (const name of order) {
      const candidate = candidates.get(name)!;
      installed.push(
        installPlugin({
          source: candidate.dir,
          pluginsDir: opts.pluginsDir,
          origin: buildOrigin(candidate.dir, originDirOverride),
          resolvedRevision,
          marketplaceName: opts.marketplaceName,
          targets,
          selection: selections.get(name),
          skipUnchanged: opts.skipUnchanged,
          now: opts.now,
          definition: name === structuralName ? definition : undefined,
        }),
      );
    }
    // Activate into the selected agents so the plugins are actually usable, not
    // just recorded/discoverable — each agent enables them via its own CLI.
    // undefined targets = all registered agents. Under skipUnchanged (the update
    // path) only re-activate plugins that actually changed — re-running an agent
    // CLI for an untouched plugin is wasted work.
    const agents = activateInstalled(opts, targets, installed, existingPlugins);

    return { order, installed, removed, converted, available, agents };
  } finally {
    cleanup?.();
  }
}
