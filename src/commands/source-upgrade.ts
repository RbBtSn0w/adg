import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join, relative } from "node:path";
import { ADAPTER_TARGETS, type AdapterTarget } from "../adapters/index.ts";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";
import { pluginContents, type PluginContents } from "../components.ts";
import { resolveInstallOrder, type PluginCandidate } from "../deps.ts";
import { toPosix } from "../fsutil.ts";
import { readLock, writeLock } from "../lock.ts";
import { readManifest } from "../manifest.ts";
import {
  prepareMigrationTransaction,
  publishMigrationTransaction,
  type PreparedMigrationPlugin,
  type MigrationPublishResult,
  type MigrationSuccessor,
} from "../migration-transaction.ts";
import { installedPluginDir, lockPath, pluginCacheRoot, pluginSourceCacheDir } from "../paths.ts";
import {
  planMigration,
  type MigrationDecision,
  type MigrationDecisionRequest,
  type MigrationPlanOptions,
} from "../upgrade-plan.ts";
import { installedHistory, marketplaceRenames, recoverLegacyHistory, requestedSelectionKnown, sourceCatalogNames } from "../source-history.ts";
import { pluginComparisonHash, type PluginChanges } from "../plugin-changes.ts";
import type { GitRunner } from "../sources.ts";
import { sourceIntent } from "../source-intent.ts";
import {
  COMPONENT_TYPES,
  resolveSelectionDependencies,
  type DefaultDefinitionProfile,
  type PluginSelection,
  type PluginLock,
  type PluginState,
  type SourceIntent,
} from "../types.ts";
import { reviewExecutables, verifiedSource, UpdateCancelled, type ReviewUpdate } from "./review-executables.ts";
export { UpdateCancelled, type SourceReview, type ReviewUpdate, type ReviewAnswer } from "./review-executables.ts";
import { discoverPlugins } from "./install/discovery.ts";
import { synthesizeDefaultDslPlugin } from "./install/default-dsl.ts";
import { parseGitHubSource } from "../sources.ts";
import { installPlugin, verifyInstallation } from "./install/install-one.ts";
import type { UpdatePhase } from "../render/progress.ts";
import type { MarketplaceGroup, PluginUpdateSourceResult } from "./marketplace.ts";

interface UpgradeOptions {
  group: MarketplaceGroup;
  checkout: string;
  revision?: string;
  pluginsDir: string;
  all?: boolean;
  repair?: boolean;
  activate?: boolean;
  scope: AgentScope;
  agents?: Agent[];
  refreshExisting?: { name: string; target: string }[];
  targets?: AdapterTarget[];
  now: string;
  review?: ReviewUpdate;
  gitRunner?: GitRunner;
  onProgress?: (phase: UpdatePhase) => void;
  onAgentResults?: (results: AgentSyncResult[]) => void;
  onNativeManaged?: (targets: NonNullable<MigrationPublishResult["managedNative"]>) => void;
}

function emptyContents(): PluginContents {
  return { skills: [], agents: [], commands: [], mcp: [], hooks: [], apps: [] };
}

/** Resolve a newly available runtime's saved state conflict within the same update. */
export async function publishUpgradeTransaction(
  journalPath: string, targets: Agent[], source: string, review?: ReviewUpdate, ref?: string, repairTargets?: string[],
): Promise<MigrationPublishResult> {
  const first = await publishMigrationTransaction(journalPath, { targets, repairTargets });
  if (!first.stateDecisions?.length || !review) return first;
  const answer = await review({ source, executable: [], history: first.stateDecisions.map(item => ({
    id: `state:${item.agent}/${item.plugin}`, skills: [], choices: ["enabled", "disabled"],
  })) });
  if (!answer) {
    const cancelled = new UpdateCancelled();
    cancelled.partial = {
      remote: [{ source, ...(ref ? { ref } : {}), updated: [], unchanged: [], deleted: [], available: [],
        pendingRuntime: first.failures.map(item => item.message) }],
      local: { results: [], missing: [] }, agents: first.agents ?? [],
    };
    throw cancelled;
  }
  const stateDecisions = first.stateDecisions.map(item => {
    const action = answer.history[`state:${item.agent}/${item.plugin}`]?.action;
    if (action !== "enabled" && action !== "disabled") throw new Error(`Choose the runtime state for ${item.plugin}.`);
    return { ...item, enabled: action === "enabled" };
  });
  const last = await publishMigrationTransaction(journalPath, { targets, stateDecisions, repairTargets });
  const resolved = new Set(stateDecisions.map(item => `${item.agent}/${item.plugin}`));
  const prior = (first.agents ?? []).map(result => ({ ...result,
    failures: result.failures?.filter(item => !item.plugin || !resolved.has(`${result.agent}/${item.plugin}`)),
    unverified: result.unverified?.filter(name => !resolved.has(`${result.agent}/${name}`)),
  }));
  return { ...last, agents: [...prior, ...(last.agents ?? [])] };
}

async function reviewRuntimeStates(
  destinations: import("../upgrade-plan.ts").MigrationDestination[], targets: Agent[],
  pluginsDir: string, scope: AgentScope, source: string, lock: PluginLock, review?: ReviewUpdate,
): Promise<{ successors: MigrationSuccessor[]; blockers: string[] }> {
  const successors: MigrationSuccessor[] = destinations.map(item => ({ name: item.name, predecessors: item.predecessors }));
  const questions: MigrationDecisionRequest[] = [];
  for (const target of targets.filter(agent => agent.detect())) {
    const names = [...new Set(destinations.flatMap(item => [item.name, ...item.predecessors]))];
    if (!names.length) continue;
    const records = target.available() ? target.inspectPlugins?.({ pluginsDir, scope, plugins: names }) : undefined;
    for (const [index, dest] of destinations.entries()) {
      if (dest.stateResolved) {
        (successors[index]!.enabledByTarget ??= {})[target.id] = dest.state === "enabled";
        continue;
      }
      if (!Array.isArray(records) || records.some(item => item.name === dest.name && item.installed)) continue;
      if (typeof lock.plugins[dest.name]?.runtimeStates?.[target.id] === "boolean") continue;
      const states = new Set(dest.predecessors.flatMap(name => {
        const native = records.find(item => item.installed && item.name === name);
        if (native) return [native.enabled];
        const saved = lock.plugins[name]?.runtimeStates?.[target.id];
        if (typeof saved === "boolean") return [saved];
        return lock.plugins[name]?.state === "disabled" ? [false] : [];
      }));
      if (states.size > 1) questions.push({ id: `state:${target.id}/${dest.name}`, skills: [], choices: ["enabled", "disabled"] });
    }
  }
  if (!questions.length) return { successors, blockers: [] };
  if (!review) return { successors, blockers: questions.map(item => `Review ${item.id}: enabled state`) };
  const answer = await review({ source, history: questions, executable: [] });
  if (!answer) throw new UpdateCancelled();
  for (const question of questions) {
    const action = answer.history[question.id]?.action;
    if (action !== "enabled" && action !== "disabled") return { successors, blockers: [`Choose ${question.id}.`] };
    const [target, name] = question.id.slice(6).split("/");
    (successors.find(item => item.name === name)!.enabledByTarget ??= {})[target!] = action === "enabled";
  }
  return { successors, blockers: [] };
}

/** Prepare the complete checked source before publishing payloads or native changes. */
export async function upgradeSource(opts: UpgradeOptions): Promise<PluginUpdateSourceResult> {
  const { group, checkout, pluginsDir } = opts;
  const lock = readLock(lockPath(pluginsDir));
  const { candidates } = discoverPlugins(checkout);
  const declaredNames = sourceCatalogNames(checkout);
  if (declaredNames) for (const name of candidates.keys()) if (!declaredNames.has(name)) candidates.delete(name);
  const profiles = group.installed.filter((name) => lock.plugins[name]?.definition);
  const generated = new Map<string, DefaultDefinitionProfile>();
  const cleanups: (() => void)[] = [];
  try {
    if (profiles.length && !candidates.size && !declaredNames) {
      for (const name of profiles) {
        const entry = lock.plugins[name]!;
        const definition = entry.definition!;
        const result = await synthesizeDefaultDslPlugin(
          {
            spec: group.source,
            pluginsDir,
            as: definition.as,
            structuralIdentity: name,
            defaultDescription: definition.description,
            preparedSourceDir: checkout,
            authorizedComponents: definition.authorizedComponents,
          },
          parseGitHubSource(group.source),
          checkout,
          opts.revision,
        );
        cleanups.push(result.cleanup);
        candidates.set(name, result.candidates.get(name)!);
        generated.set(name, result.definition);
      }
    }
    if (profiles.some((name) => !candidates.has(name))) {
      const missing = profiles.filter(name => !candidates.has(name));
      throw new Error(`Source definition changed, but none match the installed identity "${missing.join('", "')}"; all structural identities were preserved.`);
    }
    return await upgradeCandidates(opts, candidates, generated);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

async function resolveHistoricalSelections(inputs: MigrationPlanOptions, intent: SourceIntent, review?: ReviewUpdate, reconsider = false) {
  let plan = planMigration(inputs);
  const decisions: Record<string, MigrationDecision> = {};
  const notRestored: string[] = [];
  const restored: string[] = [];
  while (plan.decisions.length && !plan.blockers.length) {
    const pending = plan.decisions;
    const uncertain = pending.filter(item => {
      const prior = intent.deferredRecovery?.find(entry => entry.id === item.id);
      const unchanged = prior && isDeepStrictEqual(prior.skills, item.skills);
      if ((item.uncertain || item.choices.includes("restore")) && (!review || (unchanged && !reconsider))) {
        decisions[item.id] = { action: "keep" };
        return false;
      }
      return true;
    });
    const answer =
      uncertain.length && review
        ? await review({ source: intent.source, history: uncertain, executable: [] })
        : { history: {}, allow: [] };
    if (!answer) throw new UpdateCancelled();
    if (uncertain.length && !review)
      return {
        plan,
        notRestored, restored,
        blockers: uncertain.map((item) => `Review ${item.id}: ${item.skills.join(", ") || "enabled state"}`),
      };
    for (const item of uncertain) {
      const choice = answer.history[item.id];
      if (!choice || !item.choices.includes(choice.action))
        return { plan, notRestored, restored, blockers: [`Choose how to apply ${item.id}.`] };
      decisions[item.id] = choice;
      if (item.uncertain || item.choices.includes("restore")) {
        if (choice.action === "restore") restored.push(...item.skills);
        if (choice.action === "select") restored.push(...(choice.skills ?? []));
      }
      if (choice.action === "select")
        notRestored.push(...item.skills.filter((skill) => !choice.skills?.includes(skill)));
    }
    plan = planMigration({ ...inputs, decisions });
  }
  return { plan, notRestored, restored, blockers: plan.blockers };
}

async function upgradeCandidates(
  opts: UpgradeOptions,
  candidates: Map<string, PluginCandidate>,
  generated: Map<string, DefaultDefinitionProfile>,
): Promise<PluginUpdateSourceResult> {
  const { group, checkout, pluginsDir } = opts;
  const lock = readLock(lockPath(pluginsDir));
  const previous = sourceIntent(lock, group.source, group.ref);
  const intent: SourceIntent = structuredClone(
    previous ?? {
      source: group.source,
      ref: group.ref,
      mode: "selected",
      roots: group.installed,
      excluded: [],
      appliedMigrations: [],
    },
  );
  const base = {
    source: group.source,
    ...(group.ref ? { ref: group.ref } : {}),
    updated: [],
    unchanged: [],
    deleted: [],
    available: [],
  };
  const needsDecision = (messages: string[]): PluginUpdateSourceResult => ({ ...base, actionRequired: messages });
  const inventory = [...candidates].map(([name, p]) => ({
    name, version: p.manifest.version, contents: pluginContents(p.dir, p.manifest),
  }));
  const source = { type: "github" as const, repo: group.source, ref: group.ref };
  const currentHistory = installedHistory(pluginsDir, lock, group.source, group.ref);
  const unverifiable = group.installed.filter(name => !currentHistory.some(item => item.name === name) && !requestedSelectionKnown(lock.plugins[name]!));
  if (unverifiable.length) return needsDecision(unverifiable.map(name => `Cannot verify the historical selection of ${name}; preserve its contents until a selection is provided.`));
  const historicalInventory = intent.history?.length ? intent.history : await recoverLegacyHistory({
    source: group.source, ref: group.ref, lock, installed: currentHistory,
    currentNames: new Set(candidates.keys()), runner: opts.gitRunner,
  });
  const history = historicalInventory.map(item => {
    const proof = currentHistory.find(current => current.name === item.name && current.version === item.version && current.sourceHash === item.sourceHash);
    const known = requestedSelectionKnown(item);
    const evidence = item.evidence ?? (known ? "selection" : proof?.evidence ?? "catalog");
    return { ...item, selectionKnown: known, evidence,
      ...(!known && !item.evidence && proof ? { effectiveSelection: proof.effectiveSelection } : {}),
      uncertain: "uncertain" in item ? Boolean(item.uncertain) : evidence === "catalog" && !known };
  });
  const installed = Object.entries(lock.plugins).map(([name, entry]) => {
    const proof = currentHistory.find(p => p.name === name);
    return { ...entry, name, contents: proof?.contents ?? emptyContents(), effectiveSelection: proof?.effectiveSelection,
      selectionKnown: proof?.selectionKnown ?? false, evidence: proof?.evidence,
      uncertain: proof?.evidence === "catalog" && proof.selectionKnown !== true };
  });
  const { plan, notRestored, restored, blockers } = await resolveHistoricalSelections(
    { source, installed, history, candidates: inventory, renames: marketplaceRenames(checkout), deferredRecovery: intent.deferredRecovery },
    intent, opts.review, opts.repair,
  );
  if (blockers.length) return needsDecision(blockers);
  plan.applied = plan.applied.filter(id => !intent.appliedMigrations.includes(id));
  if (plan.deferredRecovery.length) intent.deferredRecovery = plan.deferredRecovery;
  else delete intent.deferredRecovery;
  const deferredRecovery = [...new Set(plan.deferredRecovery.flatMap(item => item.skills))].sort();

  const previouslyRetained = intent.retained ?? [];
  const missing = group.installed.filter(
    (name) => !candidates.has(name) && !plan.retired.includes(name) && !plan.retained.includes(name),
  );
  const retained = new Set([...previouslyRetained.filter((name) => missing.includes(name)), ...plan.retained]);
  const unknown = missing.filter((name) => !retained.has(name));
  if (!opts.review && unknown.length && group.installed.every((name) => !candidates.has(name))) {
    for (const name of candidates.keys()) {
      if ((intent.mode === "all" || opts.all) && lock.plugins[name] && !group.installed.includes(name)) {
        throw new Error(`name collision: "${name}" belongs to another source`);
      }
    }
    return {
      ...base,
      missingUpstream: unknown,
      available: [...candidates.keys()].sort(),
      actionRequired: unknown.map((name) => `Keep or remove ${name} (unmapped:${name}).`),
    };
  }
  if (opts.review && unknown.length) {
    const questions: MigrationDecisionRequest[] = unknown.map((name) => ({
      id: "unmapped:" + name,
      skills: [name],
      choices: ["keep", "drop"],
    }));
    const answer = await opts.review({ source: group.source, history: questions, executable: [] });
    if (!answer) throw new UpdateCancelled();
    for (const name of unknown) {
      const choice = answer.history["unmapped:" + name]?.action;
      if (choice === "keep") retained.add(name);
      else if (choice === "drop") plan.retired.push(name);
      else return needsDecision(["Choose whether to keep " + name + "."]);
    }
  }
  const pendingMissing = missing.filter((name) => !retained.has(name) && !plan.retired.includes(name));
  if (retained.size) {
    intent.retained = [...retained].sort();
    intent.retainedAtRevision = opts.revision;
  } else {
    delete intent.retained;
    delete intent.retainedAtRevision;
  }
  const destinations = new Map<string, { selection?: PluginSelection; state: PluginState }>();
  const included = new Set(group.installed.filter((name) => candidates.has(name) && !plan.retired.includes(name) && !retained.has(name)));
  const follow = !pendingMissing.length && (intent.mode === "all" || opts.all);
  const excluded = new Set(intent.excluded);
  if (follow)
    for (const name of candidates.keys()) {
      const entry = lock.plugins[name];
      if (!excluded.has(name) && !retained.has(name) && !plan.retired.includes(name) && (!entry || group.installed.includes(name))) included.add(name);
    }
  for (const dest of plan.destinations) {
    if (excluded.has(dest.name)) return needsDecision([`Previously removed replacement: ${dest.name}`]);
    included.add(dest.name);
    destinations.set(dest.name, dest);
  }
  // Unknown recovery targets cannot acquire unrelated contents through --all.
  for (const address of deferredRecovery) {
    const name = address.split(":")[0]!;
    if (!lock.plugins[name] && !destinations.has(name)) included.delete(name);
  }
  for (const name of [...included]) {
    for (const dependency of intent.withDeps === false ? [] : resolveInstallOrder(name, candidates)) {
      if (excluded.has(dependency)) return needsDecision([`${name} requires excluded plugin ${dependency}.`]);
      included.add(dependency);
    }
  }
  for (const [name, entry] of Object.entries(lock.plugins)) {
    if (plan.retired.includes(name)) continue;
    const dependencies = included.has(name)
      ? candidates.get(name)?.manifest.dependencies?.map((d) => d.name)
      : Object.keys(entry.dependencies ?? {});
    if (dependencies?.some((dep) => plan.retired.includes(dep)))
      return needsDecision([`${name} still requires a retired plugin.`]);
  }
  const targets =
    opts.targets ?? intent.targets?.filter((id): id is AdapterTarget => ADAPTER_TARGETS.includes(id as AdapterTarget));
  const projectionTargets = [...new Set<AdapterTarget>([
    ...(targets ?? ADAPTER_TARGETS), ...(opts.repair ? ["codex" as const] : []),
  ])];
  const selectionFor = (name: string): PluginSelection | undefined => {
    const old = lock.plugins[name];
    const mapped = destinations.get(name);
    const saved = intent.desiredSelections;
    if (mapped) return mapped.selection;
    if (saved && Object.hasOwn(saved, name)) return saved[name] ?? undefined;
    if (old)
      return (
        old.selection ??
        (currentHistory.find(item => item.name === name)?.selectionKnown === false
          ? currentHistory.find(item => item.name === name)?.effectiveSelection : undefined) ??
        (old.definition?.authorizedComponents && COMPONENT_TYPES.some(type =>
          !old.definition!.authorizedComponents!.includes(type) && inventory.find(item => item.name === name)!.contents[type].length)
          ? { components: old.definition.authorizedComponents } : undefined)
      );
    if (!follow) return undefined;
    const selection = intent.selection;
    if (!selection) return undefined;
    const contents = inventory.find((item) => item.name === name)!.contents;
    return {
      ...selection,
      ...(selection.skills ? { skills: selection.skills.filter((skill) => contents.skills.includes(skill)) } : {}),
      ...(selection.mcp ? { mcp: selection.mcp.filter((server) => contents.mcp.includes(server)) } : {}),
    };
  };
  const proposed = [...included].map((name) => {
    if (lock.plugins[name] && !group.installed.includes(name))
      throw new Error(`dependency plugin "${name}" belongs to a different source ref`);
    let selection = selectionFor(name);
    const blocked = new Set(deferredRecovery.filter(address => address.startsWith(`${name}:`)).map(address => address.slice(name.length + 1)));
    if (blocked.size) {
      const members = inventory.find(item => item.name === name)!.contents;
      selection = { components: [...(selection?.components ?? COMPONENT_TYPES)], ...selection,
        skills: (selection?.skills ?? members.skills).filter(skill => !blocked.has(skill)) };
    }
    return { name, candidate: candidates.get(name)!, old: lock.plugins[name], selection };
  });
  const permissions = await reviewExecutables(pluginsDir, intent, proposed, projectionTargets, opts.review);
  if (permissions.blockers.length) return needsDecision(permissions.blockers);
  const materializedSelections = new Map(
    proposed.map((item) => [item.name, permissions.selections.get(item.name) ?? item.selection]),
  );
  for (const { name, selection } of proposed) {
    if (permissions.selections.has(name)) {
      intent.desiredSelections ??= {};
      intent.desiredSelections[name] = selection ?? null;
    } else if (intent.desiredSelections) {
      delete intent.desiredSelections[name];
    }
  }
  let policyChanged = previous ? !isDeepStrictEqual(intent, previous) : Boolean(retained.size || permissions.reviewed);
  const stage = mkdtempSync(join(tmpdir(), "adg-upgrade-"));
  try {
    const prepared: PreparedMigrationPlugin[] = [];
    const unchanged: string[] = [];
    const changes: Array<{ name: string } & PluginChanges & { runtimeRefreshRequired: boolean }> = [];
    const order = [
      ...new Set(
        [...included].flatMap((name) => (intent.withDeps === false ? [name] : resolveInstallOrder(name, candidates))),
      ),
    ];
    for (const name of order) {
      opts.onProgress?.({ kind: "install", index: order.indexOf(name) + 1, total: order.length, source: group.source, plugin: name });
      const p = candidates.get(name)!;
      const selection = materializedSelections.get(name);
      const origin = { ...source, path: generated.has(name) ? "." : toPosix(relative(checkout, p.dir)) || "." };
      const built = installPlugin({
        source: p.dir,
        pluginsDir: stage,
        origin,
        selection,
        selectionKnown: false,
        targets: projectionTargets,
        definition: generated.get(name),
        now: opts.now,
        resolvedRevision: opts.revision,
      });
      const entry = readLock(lockPath(stage)).plugins[name]!;
      const old = lock.plugins[name];
      const mapped = plan.destinations.find(item => item.name === name);
      const known = (plugin: string) => currentHistory.find(item => item.name === plugin)?.selectionKnown === true;
      entry.selectionKnown = old ? known(name) : mapped ? mapped.predecessors.every(known) : true;
      if (restored.some(address => address.startsWith(`${name}:`))) entry.selectionKnown = true;
      if (deferredRecovery.some(address => address.startsWith(`${name}:`))) entry.selectionKnown = false;
      const verification = old ? verifyInstallation(installedPluginDir(pluginsDir, name, old.origin), old.installedHash, old.selection, projectionTargets) : undefined;
      entry.installedAt = old?.installedAt ?? entry.installedAt;
      entry.state = destinations.get(name)?.state ?? old?.state;
      if (old?.runtimeStates) entry.runtimeStates = old.runtimeStates;
      if (
        old &&
        old.sourceHash === entry.sourceHash &&
        old.installedHash === entry.installedHash &&
        isDeepStrictEqual(old.selection, entry.selection) &&
        (old.state ?? "enabled") === (entry.state ?? "enabled") &&
        verification?.installationIntact && verification.projectionsIntact &&
        verifiedSource(pluginsDir, name, old)
      ) {
        unchanged.push(name);
        continue;
      }
      const cached = old && verifiedSource(pluginsDir, name, old);
      const delta: PluginChanges = {
        version: !old || old.version !== entry.version,
        content: !cached || pluginComparisonHash(cached, readManifest(cached)) !== pluginComparisonHash(p.dir, p.manifest),
        selection: !isDeepStrictEqual(old?.selection, entry.selection),
        source: Boolean(old && opts.revision && old.resolvedRevision !== opts.revision),
      };
      const runtimeRefreshRequired = !old || delta.version || delta.selection || old.installedHash !== entry.installedHash || !verification?.projectionsIntact;
      changes.push({ name, ...delta, runtimeRefreshRequired });
      prepared.push({ name, entry, dir: built.installedTo, cacheDir: pluginSourceCacheDir(stage, name), runtimeRefreshRequired });
    }
    intent.roots = [
      ...new Set([
        ...intent.roots.filter((name) => !plan.retired.includes(name)),
        ...plan.destinations.map((p) => p.name),
        ...[...included].filter((name) => !lock.plugins[name] && follow),
      ]),
    ].sort();
    intent.appliedMigrations = [...new Set([...intent.appliedMigrations, ...plan.applied])];
    intent.history = [...currentHistory.filter(p => retained.has(p.name)), ...order.map(name => {
      const candidate = candidates.get(name)!;
      const entry = prepared.find(p => p.name === name)?.entry ?? lock.plugins[name]!;
      return { name, origin: entry.origin, version: entry.version, sourceHash: entry.sourceHash,
        contents: pluginContents(candidate.dir, candidate.manifest), selection: entry.selection,
        selectionKnown: entry.selectionKnown, evidence: entry.selectionKnown === false ? "installed" as const : "selection" as const,
        effectiveSelection: resolveSelectionDependencies(candidate.manifest, entry.selection), state: entry.state };
    })];
    policyChanged = previous ? !isDeepStrictEqual(JSON.parse(JSON.stringify(intent)), previous) : true;
    const checkpointNeeded = opts.revision && unchanged.some(name => lock.plugins[name]!.resolvedRevision !== opts.revision);
    const knownRuntime = (id: string) => group.installed.some(name => Object.hasOwn(lock.plugins[name]?.runtimeStates ?? {}, id));
    const selectedRuntime = opts.activate ? (opts.agents ?? [...new Map([
      ...resolveAgents(targets).filter(agent => targets !== undefined || agent.detect() || agent.available() || knownRuntime(agent.id)),
      ...(opts.repair ? resolveAgents(["codex"]) : []),
    ].map(agent => [agent.id, agent])).values()]) : [];
    // Changed native payloads belong to the same durable transaction, including
    // Codex repair; standalone repair still handles unchanged missing members.
    const runtime = selectedRuntime;
    const retireTargets = plan.retired.length ? (opts.agents ?? resolveAgents().filter(agent => agent.detect() || knownRuntime(agent.id))) : [];
    const allRuntime = [...new Map([...runtime, ...retireTargets].map(agent => [agent.id, agent])).values()];
    const refreshExisting = opts.refreshExisting?.filter(item => unchanged.includes(item.name));
    const successors = plan.destinations.map(item => ({ ...item, predecessors: item.predecessors.filter(name => group.installed.includes(name)) }));
    const stateReview = await reviewRuntimeStates(successors, allRuntime, pluginsDir, opts.scope, group.source, lock, opts.review);
    if (stateReview.blockers.length) return needsDecision(stateReview.blockers);
    if (!prepared.length && !plan.retired.length && !plan.applied.length && !policyChanged && !refreshExisting?.length && !checkpointNeeded) {
      return {
        ...base,
        unchanged,
        retained: [...retained],
        ...(deferredRecovery.length ? { deferredRecovery } : {}),
        available: [...candidates.keys()].filter((name) => !included.has(name) && !lock.plugins[name]),
        ...(pendingMissing.length ? { missingUpstream: pendingMissing } : {}),
      };
    }
    const journal = await prepareMigrationTransaction({
      pluginsDir,
      source: group.source,
      ref: group.ref,
      revision: opts.revision ?? (prepared.map((p) => p.entry.sourceHash).join(",") || "verified-local-snapshot"),
      prepared,
      retire: plan.retired,
      refreshExisting,
      scope: opts.scope,
      targets: runtime,
      retireTargets,
      inspectionRequiredTargets: opts.repair ? ["codex"] : undefined,
      successors: stateReview.successors,
      projectionTargets,
      sourceIntent: intent,
    });
    for (const agent of allRuntime) {
      const count = prepared.filter(p => p.runtimeRefreshRequired && p.entry.state !== "disabled").length;
      if (count) opts.onProgress?.({ kind: "activate", agent: agent.id, count });
    }
    const published = await publishUpgradeTransaction(journal, opts.activate ? allRuntime : [], group.source, opts.review, group.ref, opts.repair ? ["codex"] : undefined);
    opts.onNativeManaged?.(published.managedNative ?? []);
    opts.onAgentResults?.(published.agents ?? []);
    if (published.complete && opts.revision && unchanged.length) {
      const after = readLock(lockPath(pluginsDir));
      for (const name of unchanged) after.plugins[name]!.resolvedRevision = opts.revision;
      writeLock(lockPath(pluginsDir), after);
    }
    return {
      ...base,
      updated: prepared.map((p) => p.name),
      unchanged,
      retained: [...retained],
      migrated: published.complete ? plan.applied : [],
      deleted: published.complete ? plan.retired : [],
      notRestored,
      ...(deferredRecovery.length ? { deferredRecovery } : {}),
      restored: published.complete ? restored : [],
      changes,
      ...(pendingMissing.length ? { missingUpstream: pendingMissing } : {}),
      available: [...candidates.keys()].filter((name) => !included.has(name) && !lock.plugins[name]).sort(),
      ...(!published.complete ? { pendingRuntime: published.failures.map((f) => f.message) } : {}),
    };
  } finally {
    rmSync(pluginCacheRoot(stage), { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}
