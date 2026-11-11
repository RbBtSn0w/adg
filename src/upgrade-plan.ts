import { createHash } from "node:crypto";
import { exposedContents, type PluginContents } from "./components.ts";
import { COMPONENT_TYPES, type DeferredSkillRecovery, type PluginSelection, type PluginSource, type PluginState, type SourceHistoryEntry } from "./types.ts";

export interface MigrationDecision {
  action: "keep" | "restore" | "select" | "enabled" | "disabled" | "drop";
  skills?: string[];
}
export interface MigrationDecisionRequest {
  id: string;
  skills: string[];
  choices: MigrationDecision["action"][];
  uncertain?: boolean;
}
export interface HistoricalPlugin {
  name: string;
  version: string;
  origin: PluginSource;
  contents: PluginContents;
  sourceHash?: string;
  selection?: PluginSelection;
  selectionKnown?: boolean;
  effectiveSelection?: PluginSelection;
  state?: PluginState;
  evidence?: SourceHistoryEntry["evidence"];
  /** A legacy newer owner cannot prove which historical skills were selected. */
  uncertain?: boolean;
}
export interface UpgradeCandidate {
  name: string;
  version: string;
  contents: PluginContents;
}
export interface MigrationDestination {
  name: string;
  selection?: PluginSelection;
  state: PluginState;
  predecessors: string[];
  stateResolved?: boolean;
}
export interface MigrationPlan {
  applied: string[];
  destinations: MigrationDestination[];
  retired: string[];
  retained: string[];
  decisions: MigrationDecisionRequest[];
  blockers: string[];
  deferredRecovery: DeferredSkillRecovery[];
}
export interface MigrationPlanOptions {
  source: PluginSource;
  installed: HistoricalPlugin[];
  history?: HistoricalPlugin[];
  candidates: UpgradeCandidate[];
  renames?: Record<string, string | null>;
  deferredRecovery?: DeferredSkillRecovery[];
  decisions?: Record<string, MigrationDecision>;
}

function sameSource(a: PluginSource, b: PluginSource): boolean {
  return a.type === "github" && b.type === "github" && a.repo.toLowerCase() === b.repo.toLowerCase() && a.ref === b.ref;
}

const unique = (items: string[]) => [...new Set(items)].sort();
const enabledState = (plugin: HistoricalPlugin) => plugin.state ?? "enabled";
export function historyIdentity(plugin: HistoricalPlugin): string {
  return "history-" + createHash("sha256").update(JSON.stringify([
    plugin.name, plugin.version, plugin.sourceHash, plugin.contents, plugin.selection,
  ])).digest("hex");
}

function historicalSnapshot(plugin: HistoricalPlugin): SourceHistoryEntry {
  return { name: plugin.name, version: plugin.version, origin: plugin.origin, contents: plugin.contents,
    sourceHash: plugin.sourceHash, selection: plugin.selection, selectionKnown: plugin.selectionKnown,
    effectiveSelection: plugin.effectiveSelection, state: plugin.state, evidence: plugin.evidence };
}

/** Resolve existing marketplace identity metadata before touching any installation. */
export function resolveRenames(renames: Record<string, string | null>, names: Set<string>): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const former of Object.keys(renames)) {
    const seen = new Set<string>();
    let name: string | null = former;
    while (name !== null && Object.hasOwn(renames, name)) {
      if (seen.has(name)) throw new Error(`Marketplace rename cycle: ${former}`);
      seen.add(name);
      name = renames[name]!;
    }
    if (name !== null && !names.has(name)) throw new Error(`Missing marketplace rename destination: ${name}`);
    result.set(former, name);
  }
  return result;
}

/** Plan from client-owned installation evidence and an ordinary current catalog. */
export function planMigration(options: MigrationPlanOptions): MigrationPlan {
  const result: MigrationPlan = { applied: [], destinations: [], retired: [], retained: [], decisions: [], blockers: [], deferredRecovery: [] };
  const current = new Map(options.installed.filter(p => sameSource(p.origin, options.source)).map(p => [p.name, p]));
  const history = new Map((options.history ?? []).filter(p => sameSource(p.origin, options.source)).map(p => [p.name, p]));
  const candidates = new Map(options.candidates.map(p => [p.name, p]));
  let renames: Map<string, string | null>;
  try { renames = resolveRenames(options.renames ?? {}, new Set(candidates.keys())); }
  catch (error) { result.blockers.push((error as Error).message); return result; }
  const destinations = new Map<string, MigrationDestination>();
  const states = new Map<string, Set<PluginState>>();
  const incoming = new Map<string, Set<string>>();
  const ownSelections = new Map<string, PluginSelection>();
  const renamedFrom = new Map<string, HistoricalPlugin[]>();
  const visible = new Set([...current.values()].flatMap(p => exposedContents(p.contents, p.effectiveSelection ?? p.selection).skills));
  const ensure = (name: string, predecessor: HistoricalPlugin, full = false): MigrationDestination | undefined => {
    const unrelated = options.installed.find(p => p.name === name && !sameSource(p.origin, options.source));
    if (unrelated) { result.blockers.push(`Destination belongs to a different source: ${name}`); return; }
    const existing = current.get(name);
    const existingSelection = existing?.selection ?? (existing?.selectionKnown === false ? existing.effectiveSelection ?? { components: [] } : undefined);
    let dest = destinations.get(name);
    if (!dest) {
      dest = { name, state: enabledState(existing ?? predecessor), predecessors: [],
        ...(existingSelection ? { selection: structuredClone(existingSelection) }
          : existing || full ? {} : { selection: { components: ["skills"], skills: [] } }) };
      destinations.set(name, dest);
      states.set(name, new Set(existing ? [enabledState(existing)] : []));
    }
    dest.predecessors = unique([...dest.predecessors, predecessor.name]);
    const contributions = states.get(name)!;
    contributions.add(enabledState(predecessor));
    if (contributions.size === 1) dest.state = enabledState(predecessor);
    return dest;
  };

  const empty = (): PluginContents => ({ skills: [], agents: [], commands: [], hooks: [], apps: [], mcp: [] });
  const work = [...current.values()].map(old => ({ old, basis: history.get(old.name) ?? old, recovery: undefined as DeferredSkillRecovery | undefined }));
  for (const recovery of options.deferredRecovery ?? []) {
    const original = recovery.history;
    if (!sameSource(original.origin, options.source)) continue;
    // Deferred candidates remain evidence even after their former owner retired.
    const skills = unique(recovery.skills.map(address => address.split(":").at(-1)!)).filter(skill => !visible.has(skill));
    if (!skills.length) continue;
    work.push({ old: { ...original, contents: empty(), effectiveSelection: undefined },
      basis: { ...original, contents: { ...empty(), skills }, selection: undefined, effectiveSelection: undefined, uncertain: true }, recovery });
  }
  const handled = new Set<string>();
  for (const { old, basis, recovery } of work) {
    if (recovery && handled.has(recovery.id)) continue;
    const reference = { ...basis, state: old.state };
    if (!recovery && renames.has(old.name)) {
      const target = renames.get(old.name)!;
      if (old.evidence === "catalog" && old.selectionKnown !== true) {
        const id = target === null ? `unmapped:${old.name}` : historyIdentity(basis);
        handled.add(id);
        const skills = target === null ? old.contents.skills.map(skill => `${old.name}:${skill}`)
          : candidates.get(target)!.contents.skills.map(skill => `${target}:${skill}`);
        const choice = options.decisions?.[id];
        if (!choice) result.decisions.push({ id, skills, choices: target === null ? ["keep", "drop"] : ["keep", "select", "restore"], uncertain: true });
        if (!choice || choice.action === "keep" || (choice.action === "select" && !choice.skills?.length)) {
          result.retained.push(old.name);
          result.deferredRecovery.push({ id, history: historicalSnapshot(basis), skills: unique(skills) });
          continue;
        }
        if (target !== null) {
          const chosen = choice.action === "restore" ? skills : (choice.skills ?? []).filter(skill => skills.includes(skill));
          if (chosen.length) {
            const dest = ensure(target, old);
            if (dest) incoming.set(target, new Set(chosen.map(address => address.slice(target.length + 1))));
          }
        }
        result.retired.push(old.name);
        result.applied.push(id);
        continue;
      }
      if (target !== null && ensure(target, old, true)) {
        renamedFrom.set(target, [...(renamedFrom.get(target) ?? []), old]);
      }
      result.retired.push(old.name);
      result.applied.push(historyIdentity(basis));
      continue;
    }
    const historical = exposedContents(basis.contents, basis.uncertain && basis.selectionKnown !== true ? undefined : basis.effectiveSelection ?? basis.selection);
    const actual = exposedContents(old.contents, old.effectiveSelection ?? old.selection);
    const requested = exposedContents(basis.contents, basis.selection);
    const exposed = { ...actual, skills: unique([...historical.skills, ...actual.skills]) };
    const moves: Array<{ skill: string; owner: string }> = [];
    const explicitMoves = new Set<string>();
    const unavailable = new Set<string>();
    let unresolved = false;
    for (const skill of exposed.skills) {
      // New manifests recalculate mandatory dependencies from requested policy.
      // A previously derived skill is not a request to install another plugin.
      if (basis.selection && basis.selectionKnown !== false && !requested.skills.includes(skill)) continue;
      if (!recovery && old.evidence !== "catalog" && candidates.get(old.name)?.contents.skills.includes(skill)) continue;
      const sharedBefore = !recovery && [...current.values()].some(peer => peer.name !== old.name
        && (history.size ? history.get(peer.name) : peer)?.contents.skills.includes(skill));
      if (sharedBefore) { if (!candidates.has(old.name)) unresolved = true; continue; }
      const owners = options.candidates.filter(p => p.contents.skills.includes(skill));
      if (owners.length === 0) {
        if (recovery) unavailable.add(skill);
        else if (!candidates.has(old.name)) unresolved = true;
        continue;
      }
      if (owners.length > 1) {
        const uncertain = Boolean(recovery) || Boolean(basis.uncertain && !visible.has(skill));
        const id = uncertain ? `ownership:${historyIdentity(recovery?.history ?? basis)}:${skill}` : `ownership:${old.name}:${skill}`;
        const decision = options.decisions?.[id];
        const addresses = owners.map(p => `${p.name}:${skill}`).sort();
        const chosen = decision?.skills?.filter(address => addresses.includes(address));
        if (decision?.action === "select" && chosen?.length === 1) {
          moves.push({ skill, owner: chosen[0]!.split(":")[0]! });
          if (uncertain) explicitMoves.add(chosen[0]!);
        } else if (decision?.action === "keep") {
          if (uncertain) {
            result.deferredRecovery.push({ id, history: recovery?.history ?? historicalSnapshot(basis), skills: addresses });
            if (!recovery && old.evidence === "catalog") result.retained.push(old.name);
          } else {
            unresolved = true;
            if (!candidates.has(old.name)) result.retained.push(old.name);
            else result.blockers.push(`Ambiguous skill owner retained: ${old.name}:${skill}`);
          }
        } else result.decisions.push({ id, skills: addresses, choices: ["keep", "select"], ...(uncertain ? { uncertain: true } : {}) });
        continue;
      }
      moves.push({ skill, owner: owners[0]!.name });
    }
    if (recovery && unavailable.size) result.deferredRecovery.push({ ...recovery,
      skills: recovery.skills.filter(address => unavailable.has(address.split(":").at(-1)!)) });
    if (!moves.length || unresolved) {
      continue;
    }
    const retiring = !recovery && !candidates.has(old.name);
    if (retiring && COMPONENT_TYPES.some(component => component !== "skills" && exposed[component].length > 0)) {
      result.blockers.push(`Unmapped native components in retired plugin: ${old.name}`);
      continue;
    }
    const missing = basis.uncertain ? moves.filter(move => !visible.has(move.skill) && !explicitMoves.has(`${move.owner}:${move.skill}`)) : [];
    const id = recovery?.id ?? historyIdentity(basis);
    if (recovery && handled.has(id)) continue;
    handled.add(id);
    const choice = options.decisions?.[id];
    if (missing.length && !choice) result.decisions.push({
      id, skills: missing.map(move => `${move.owner}:${move.skill}`).sort(), choices: ["keep", "restore", "select"],
    });
    if (missing.length && choice?.action === "keep") result.deferredRecovery.push({
      id, history: recovery?.history ?? historicalSnapshot(basis),
      skills: missing.map(move => `${move.owner}:${move.skill}`).sort(),
    });
    if (!recovery && missing.length && choice?.action === "keep" && old.evidence === "catalog") result.retained.push(old.name);
    for (const move of moves) {
      const address = `${move.owner}:${move.skill}`;
      if (missing.includes(move) && choice?.action !== "restore" && !(choice?.action === "select" && choice.skills?.includes(address))) continue;
      const dest = ensure(move.owner, reference);
      if (dest) {
        const skills = incoming.get(move.owner) ?? new Set<string>();
        skills.add(move.skill);
        incoming.set(move.owner, skills);
      }
    }
    if (retiring && !result.retained.includes(old.name)) result.retired.push(old.name);
    else if (!recovery && !basis.uncertain) {
      const dest = ensure(old.name, reference);
      if (dest) {
        const remaining = (basis.selection && basis.selectionKnown !== false ? requested.skills : exposed.skills)
          .filter(skill => !moves.some(move => move.skill === skill));
        ownSelections.set(old.name, { ...basis.selection, components: [...(basis.selection?.components ?? COMPONENT_TYPES)], skills: remaining });
      }
    }
    if (!recovery || choice?.action === "restore" || choice?.action === "select") result.applied.push(id);
  }
  for (const [name, dest] of destinations) {
    const existing = current.get(name);
    const existingSelection = existing?.selection ?? (existing?.selectionKnown === false ? existing.effectiveSelection ?? { components: [] } : undefined);
    let selection = ownSelections.get(name) ?? (existingSelection ? structuredClone(existingSelection) : dest.selection);
    const renamed = renamedFrom.get(name) ?? [];
    if (renamed.length === 1 && !existing) {
      const former = renamed[0]!;
      const requested = former.selection ?? (former.selectionKnown === false ? former.effectiveSelection : undefined);
      selection = requested ? structuredClone(requested) : undefined;
    }
    if (renamed.length > 1 && !existing) selection = { components: [], skills: [], mcp: [] };
    if (selection && (existing || renamed.length > 1)) {
      for (const former of renamed) {
        const members = exposedContents(former.contents, former.selectionKnown === false ? former.effectiveSelection : former.selection);
        for (const component of COMPONENT_TYPES.filter(component => members[component].length)) {
          if (!selection.components.includes(component)) {
            selection.components.push(component);
            if (component === "skills") selection.skills = [];
            if (component === "mcp") selection.mcp = [];
          }
          if (component === "skills" && selection.skills) selection.skills = unique([...selection.skills, ...members.skills.filter(skill => candidates.get(name)!.contents.skills.includes(skill))]);
          if (component === "mcp" && selection.mcp) selection.mcp = unique([...selection.mcp, ...members.mcp.filter(server => candidates.get(name)!.contents.mcp.includes(server))]);
        }
      }
    }
    const skills = incoming.get(name);
    if (selection && skills?.size) {
      if (!selection.components.includes("skills")) { selection.components.push("skills"); selection.skills = []; }
      if (selection.skills) selection.skills = unique([...selection.skills, ...skills]);
    }
    if (selection) selection.components = COMPONENT_TYPES.filter(component => selection!.components.includes(component));
    dest.selection = selection;
  }
  for (const [name, values] of states) {
    if (values.size < 2) continue;
    const id = `state:${name}`;
    const choice = options.decisions?.[id];
    if (choice?.action === "enabled" || choice?.action === "disabled") {
      destinations.get(name)!.state = choice.action;
      destinations.get(name)!.stateResolved = true;
    }
    else result.decisions.push({ id, skills: [], choices: ["enabled", "disabled"] });
  }
  result.applied = unique(result.applied);
  result.retained = unique(result.retained);
  result.blockers = unique(result.blockers);
  const deferred = new Map<string, DeferredSkillRecovery>();
  for (const item of result.deferredRecovery) {
    const previous = deferred.get(item.id);
    deferred.set(item.id, { ...item, skills: unique([...(previous?.skills ?? []), ...item.skills]) });
  }
  result.deferredRecovery = [...deferred.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.destinations = [...destinations.values()].filter(p => !result.retired.includes(p.name)).sort((a, b) => a.name.localeCompare(b.name));
  result.retired = result.blockers.length || result.decisions.length ? [] : unique(result.retired);
  return result;
}
