import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ADAPTER_TARGETS, type AdapterTarget } from "../adapters/index.ts";
import { fromNativeManifest } from "../adapters/reverse.ts";
import { adaptPlugin } from "./adapt.ts";
import { removePlugin } from "./remove.ts";
import { copyPluginDir, toPosix, writeJson } from "../fsutil.ts";
import { folderHash } from "../hash.ts";
import { packageFilter, PROJECTION_DIRS } from "../package.ts";
import { lockPath, marketplacePath, marketplaceSourcePath, pluginDir, pluginSourceCacheDir } from "../paths.ts";
import type { UpdatePhase } from "../render/progress.ts";
import { readLock, upsertEntry, writeLock } from "../lock.ts";
import { ADG_MANIFEST_PATH, readManifest } from "../manifest.ts";
import { recordTelemetryEvent } from "../telemetry.ts";
import { readMarketplace, upsertMarketplacePlugin, writeMarketplace } from "../marketplace.ts";
import { resolveInstallOrder, type PluginCandidate } from "../deps.ts";
import { cloneGitHub, gitRevision, githubRepositoryDescription, parseGitHubSource, parseSource, scanNativePlugins, scanPlugins, type GitRunner } from "../sources.ts";
import { normalizePluginSelection, pluginState, resolveSelectionDependencies, sameSource, COMPONENT_TYPES, type AdgManifest, type ComponentType, type DefaultDefinitionProfile, type LockEntry, type PluginSelection, type PluginSource } from "../types.ts";
import { pluginContents, presentComponents } from "../components.ts";
import { skillDescriptionLoader } from "../skills.ts";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";
import { effectivePackageFilter, materializePlugin, withPluginSourceCache } from "../materialize.ts";
import { resolveDefaultDsl } from "../default-dsl.ts";

export interface InstallOneOptions {
  /** Local directory containing the plugin (already fetched). */
  source: string;
  /** Destination plugins directory. */
  pluginsDir: string;
  /** Upstream provenance recorded in the lock; defaults to local copy-in. */
  origin?: PluginSource;
  /** Immutable remote commit resolved when this source was fetched. */
  resolvedRevision?: string;
  marketplaceName?: string;
  targets?: AdapterTarget[];
  now?: string;
  /**
   * Partial-install selection narrowing the physical payload and runtime manifests.
   * When omitted, a prior lock entry's selection is reused (so it survives
   * re-installs / upgrades); absent on both = expose everything.
   */
  selection?: PluginSelection;
  /**
   * Skip all work (copy, adapt, lock write) when the source's content hash and
   * version already match the recorded lock entry. Used by `update`, so a source
   * that hasn't changed upstream is detected and left untouched rather than
   * re-installed every time. The result is reported with `changed: false`.
   */
  skipUnchanged?: boolean;
  /** Rebuild the effective installation even when source and payload hashes match. */
  forceMaterialize?: boolean;
  telemetrySpan?: Pick<import("@opentelemetry/api").Span, "addEvent">;
  definition?: DefaultDefinitionProfile;
}

export interface InstallResult {
  name: string;
  version: string;
  installedTo: string;
  sourceHash: string;
  installedHash: string;
  adapted: string[];
  /**
   * True when this install changed the recorded content: a first-time install,
   * or a re-install/upgrade whose folder hash or version differs from the prior
   * lock entry. Lets `update`/`upgrade` report updated-vs-unchanged accurately.
   */
  changed: boolean;
}

// Generated runtime projections never count toward a plugin's content hash.
const HASH_IGNORE = PROJECTION_DIRS;

/** Content hash over a plugin's packaged payload (hooks files are authored content, not generated). */
function contentHash(dir: string, manifest: AdgManifest): string {
  return folderHash(dir, HASH_IGNORE, packageFilter(manifest, { includeProjections: false }));
}

/**
 * Install a single local plugin directory into a plugins directory: copy the
 * source, generate adapter manifests, compute the folder hash, and update both
 * .plugin-lock.json and marketplace.json (with denormalized discovery metadata
 * and an integrity digest).
 *
 * Refuses to overwrite a same-named plugin that came from a different upstream
 * source (cross-marketplace name collision). Only files under `pluginsDir` are
 * written — sibling files such as AGENTS.md or a global skills/ are untouched.
 */
export function installPlugin(opts: InstallOneOptions): InstallResult {
  const source = resolve(opts.source);
  const manifest = readManifest(source, opts.telemetrySpan);
  const name = manifest.name;
  // Local installs stay flat; remote sources derive a per-marketplace dir from
  // their origin. The default (no origin) is a flat local copy-in.
  const origin: PluginSource =
    opts.origin ?? { type: "local", path: source };
  const dest = pluginDir(opts.pluginsDir, name, origin);

  const lockFile = lockPath(opts.pluginsDir);
  const lock = readLock(lockFile);
  const prev = lock.plugins[name];
  if (prev && !sameSource(prev.origin, origin)) {
    throw new Error(
      `name collision: "${name}" is already installed from a different source ` +
        `(${describe(prev.origin)} vs ${describe(origin)}). Rename one to avoid the conflict.`,
    );
  }

  // A new selection wins; otherwise keep whatever a prior install recorded so
  // partial installs survive re-install / `marketplace upgrade`.
  const desiredSelection = normalizePluginSelection(opts.selection ?? prev?.selection);
  const selection = resolveSelectionDependencies(manifest, desiredSelection);

  if (selection) {
    const contents = pluginContents(source, manifest);
    if (selection.skills) {
      const invalid = selection.skills.filter((s) => !contents.skills.includes(s));
      if (invalid.length > 0) {
        throw new Error(`selected skill(s) not declared: ${invalid.join(", ")}`);
      }
    }
    if (selection.mcp) {
      const invalid = selection.mcp.filter((s) => !contents.mcp.includes(s));
      if (invalid.length > 0) {
        throw new Error(`selected mcp server(s) not declared: ${invalid.join(", ")}`);
      }
    }

    recordTelemetryEvent("adg.install.selection", {
      plugin: name,
      "components.count": selection.components.length,
      "skills.count": selection.skills ? selection.skills.length : -1,
      "mcp.count": selection.mcp ? selection.mcp.length : -1,
    }, opts.telemetrySpan);
  }

  const sourceHash = contentHash(source, manifest);
  const cacheDir = pluginSourceCacheDir(opts.pluginsDir, name);
  return withPluginSourceCache(source, cacheDir, manifest, (snapshot) => {
    // Detect-then-update compares the complete source snapshot, never the
    // selection-pruned runtime installation.
    if (!opts.forceMaterialize && opts.skipUnchanged && prev
      && prev.sourceHash === sourceHash && prev.version === manifest.version) {
      const installedIntact = existsSync(dest)
        && folderHash(dest, PROJECTION_DIRS, effectivePackageFilter(manifest, selection)) === prev.installedHash;
      if (installedIntact) {
        return {
          name,
          version: manifest.version,
          installedTo: dest,
          sourceHash,
          installedHash: prev.installedHash,
          adapted: [],
          changed: false,
        };
      }
    }

    const targets = opts.targets ?? [...ADAPTER_TARGETS];
    const adapted: string[] = [];
    let installedHash = "";
    materializePlugin({
      source: snapshot,
      destination: dest,
      manifest,
      selection,
      build: (staging) => {
        adapted.push(...adaptPlugin(staging, targets, selection).map((r) => relative(staging, r.file)));
        installedHash = folderHash(staging, PROJECTION_DIRS, effectivePackageFilter(manifest, selection));
      },
    });
    const adaptedFiles = adapted.map((file) => join(dest, file));
    const entry: Omit<LockEntry, "installedAt" | "updatedAt"> = {
      origin,
      version: manifest.version,
      sourceHash,
      installedHash,
      ...(opts.resolvedRevision ? { resolvedRevision: opts.resolvedRevision } : {}),
    };
    if (manifest.dependencies?.length) {
      entry.dependencies = Object.fromEntries(manifest.dependencies.map((d) => [d.name, d.version]));
    }
    if (desiredSelection) entry.selection = desiredSelection;
    if (prev?.state) entry.state = prev.state;
    if (opts.definition) entry.definition = opts.definition;
    const previousEntry = prev && Object.fromEntries(
      Object.entries(prev).filter(([key]) => key !== "installedAt" && key !== "updatedAt"),
    );
    const changed = !prev || !isDeepStrictEqual(previousEntry, entry);
    if (changed) {
      upsertEntry(lock, name, entry, opts.now);
      writeLock(lockFile, lock);
    }

    const marketFile = marketplacePath(opts.pluginsDir);
    const fallbackName = opts.marketplaceName ?? basename(opts.pluginsDir);
    const market = readMarketplace(marketFile, fallbackName);
    upsertMarketplacePlugin(market, {
      name,
      source: { source: "local", path: marketplaceSourcePath(opts.pluginsDir, dest) },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      ...(manifest.category ? { category: manifest.category } : {}),
    });
    writeMarketplace(marketFile, market);

    return { name, version: manifest.version, installedTo: dest, sourceHash, installedHash, adapted: adaptedFiles, changed };
  });
}

function describe(s: PluginSource): string {
  switch (s.type) {
    case "local": return `local:${s.path}`;
    case "github": return `github:${s.repo}${s.path ? `/${s.path}` : ""}`;
    case "git": return `git:${s.url}${s.path ? `/${s.path}` : ""}`;
  }
}

/** One installable plugin discovered in a source, shown to an interactive picker. */
export interface PluginChoice {
  name: string;
  description: string;
  /** True when reverse-adapted from a native Claude/Codex manifest. */
  native: boolean;
}

/** What an interactive component picker is shown for one plugin. */
export interface SelectComponentsRequest {
  name: string;
  /** Member names per category (skills/agents/commands/…). */
  contents: import("../components.ts").PluginContents;
  /** Categories the plugin actually has (non-empty). */
  present: ComponentType[];
  /** Lazy, cached `description` lookup for a skill (drives the on-demand toggle). */
  skillDescription?: (name: string) => string | undefined;
}

export interface AddOptions {
  /** Local path or owner/repo[@ref] / github URL. */
  spec: string;
  pluginsDir: string;
  /** Override the ref parsed from the spec. */
  ref?: string;
  /** Override the derived identity of a default structural plugin. */
  as?: string;
  /** Enables structural-source safety checks for non-interactive CLI calls. */
  nonInteractive?: boolean;
  /** Replayed structural authorization from a prior lock entry. */
  authorizedComponents?: ComponentType[];
  /** Internal update guard for migrating a prior structural definition in place. */
  structuralIdentity?: string;
  /** Internal update replay of the exact prior partial-install selection. */
  replaySelection?: PluginSelection;
  /** Last-known structural description, used when remote metadata lookup fails. */
  defaultDescription?: string;
  /** Internal remote checkout reuse for marketplace updates. */
  preparedSourceDir?: string;
  preparedResolvedRevision?: string;
  /** Restrict a GitHub checkout to these sub-paths (sparse checkout). */
  sparse?: string[];
  /** Injectable git clone runner (for offline testing). */
  gitRunner?: GitRunner;
  /**
   * Progress sink for the slow parts of an install. Agent re-activation spawns
   * one or two agent-CLI processes per plugin, which dominates wall-clock time
   * on `plugins update`; without this the longest phase is invisible. The
   * command layer only emits events — the CLI decides how (or whether) to draw.
   */
  onProgress?: (phase: UpdatePhase) => void;

  // ── selection (a source may hold one plugin or a whole marketplace) ──
  /** Install every plugin found in the source. */
  all?: boolean;
  /** Install only these plugin names. */
  plugins?: string[];
  /**
   * What to do when a name in `plugins` is no longer present in the source.
   * "error" (default) throws; "skip" silently drops it — used by `update`, where
   * an upstream-deleted plugin should be reported, not abort the whole refresh.
   */
  missingPlugins?: "error" | "skip";
  /**
   * Skip re-installing plugins whose source content/version already match the
   * lock (detect-then-update). Set by `update` so an unchanged upstream source
   * causes no disk churn and no agent re-activation. Off by default so `add`
   * always (re)installs.
   */
  skipUnchanged?: boolean;
  /** Resolve and install transitive plugin dependencies. Default true. */
  withDeps?: boolean;
  /**
   * Interactive picker, used only when the source holds multiple plugins and
   * none of all/plugins narrowed the selection. Returns chosen names.
   */
  selectPlugins?: (choices: PluginChoice[]) => Promise<string[]> | string[];

  targets?: AdapterTarget[];
  /**
   * Resolve adapter targets after plugins are chosen (so an interactive agent
   * picker runs second, once the user knows what they're installing). Ignored
   * when `targets` is set.
   */
  selectTargets?: () => Promise<AdapterTarget[]> | AdapterTarget[];
  marketplaceName?: string;
  now?: string;

  // ── partial install: narrow which component categories / skills are exposed ──
  /** Non-interactive: expose only these component categories. */
  only?: ComponentType[];
  /** Non-interactive: expose only these skill names (implies skills selected). */
  skillsSubset?: string[];
  /** Non-interactive: expose only these mcp server names (implies mcp selected). */
  mcpSubset?: string[];
  /**
   * Interactive gate (the "install everything?" question). Returning false
   * drops into per-plugin component selection. Skipped when only/skillsSubset
   * or mcpSubset are set. Applies only to the user-chosen plugins, not auto-deps.
   */
  confirmFull?: (plugins: string[]) => Promise<boolean> | boolean;
  /** Interactive per-plugin component picker; returns the selection to expose. */
  selectComponents?: (req: SelectComponentsRequest) => Promise<PluginSelection> | PluginSelection;

  /**
   * After installing, make the plugins usable in the selected agents (not just
   * recorded in the store) by enabling them via each agent's CLI. A no-op for an
   * agent whose CLI isn't installed. Off by default (kept out of tests).
   */
  activate?: boolean;
  /** Install scope for activation; "user" (global) or "project". Default project. */
  scope?: AgentScope;
  /** Injection seam for tests; defaults to the agents matching `targets`. */
  agents?: Agent[];
  /** Injection seam for removed store entries; defaults to every registered agent. */
  deactivationAgents?: Agent[];
}

export interface AddResult {
  order: string[];
  installed: InstallResult[];
  /** Installed plugins from the same remote source that no longer exist upstream. */
  removed: string[];
  /** Plugins reverse-adapted from a native manifest during discovery. */
  converted: string[];
  /** Every plugin name discovered in the source (installed or not). */
  available: string[];
  /** Per-agent activation outcome (when `activate` was requested). */
  agents?: AgentSyncResult[];
}

/**
 * Reverse-adapt any native (Claude/Codex) manifests under `root` into
 * `.agents/.plugin.json`, then return every ADG plugin found. After this the
 * whole source speaks ADG, so selection and install treat all plugins uniformly.
 */
function discoverPlugins(root: string): { candidates: Map<string, PluginCandidate>; converted: string[] } {
  const converted: string[] = [];
  for (const native of scanNativePlugins(root)) {
    if (native.kind === "adg") continue;
    const raw = JSON.parse(readFileSync(native.manifestFile, "utf8"));
    const manifest = fromNativeManifest(raw, native.kind, native.dir);
    writeJson(join(native.dir, ADG_MANIFEST_PATH), manifest);
    converted.push(manifest.name);
  }
  return { candidates: scanPlugins(root), converted };
}

/** Resolve which discovered plugins to install from the selection options. */
async function selectPluginNames(
  opts: AddOptions,
  candidates: Map<string, PluginCandidate>,
  converted: string[],
): Promise<string[]> {
  const names = [...candidates.keys()];

  if (opts.plugins?.length) {
    const missing = opts.plugins.filter((p) => !candidates.has(p));
    if (missing.length && opts.missingPlugins !== "skip") {
      throw new Error(`plugin(s) not found in source: ${missing.join(", ")}.\nAvailable: ${names.join(", ")}`);
    }
    return opts.plugins.filter((p) => candidates.has(p));
  }
  if (opts.all || candidates.size === 1) return names;

  if (opts.selectPlugins) {
    const convertedSet = new Set(converted);
    const choices: PluginChoice[] = [...candidates.values()].map((c) => ({
      name: c.manifest.name,
      description: c.manifest.description,
      native: convertedSet.has(c.manifest.name),
    }));
    return opts.selectPlugins(choices);
  }

  throw new Error(
    `source "${opts.spec}" contains ${candidates.size} plugins: ${names.join(", ")}.\n` +
      `Pick with --plugin <name> (repeatable), --all for everything, or run in a terminal to choose interactively.`,
  );
}

/**
 * Decide a partial-install selection for each user-chosen plugin.
 *
 * Precedence: explicit flags (--only / --skill) win and apply to every chosen
 * plugin; otherwise an interactive gate asks whether to install in full, and if
 * not, a per-plugin component picker runs (skipped for plugins with nothing
 * meaningful to choose). No selection for a plugin = expose everything.
 */
async function resolveSelections(
  opts: AddOptions,
  selected: string[],
  candidates: Map<string, PluginCandidate>,
): Promise<Map<string, PluginSelection>> {
  const selections = new Map<string, PluginSelection>();

  if (opts.only || opts.skillsSubset || opts.mcpSubset) {
    const flagSelection: PluginSelection = {
      components: opts.only ?? [...COMPONENT_TYPES],
      ...(opts.skillsSubset ? { skills: opts.skillsSubset } : {}),
      ...(opts.mcpSubset ? { mcp: opts.mcpSubset } : {}),
    };
    for (const name of selected) selections.set(name, flagSelection);
    return selections;
  }

  if (opts.replaySelection) {
    for (const name of selected) selections.set(name, opts.replaySelection);
    return selections;
  }

  if (!opts.confirmFull || !opts.selectComponents) return selections; // non-interactive default: full
  if (await opts.confirmFull(selected)) return selections; // user kept everything

  for (const name of selected) {
    const cand = candidates.get(name)!;
    const contents = pluginContents(cand.dir, cand.manifest);
    const present = presentComponents(contents);
    // Nothing meaningful to pick: a lone category with at most one member.
    if (present.length <= 1 && contents.skills.length <= 1 && contents.mcp.length <= 1) continue;
    const skillDescription = skillDescriptionLoader(cand.dir, cand.manifest);
    selections.set(name, await opts.selectComponents({ name, contents, present, skillDescription }));
  }
  return selections;
}

/** True when a locked plugin belongs to the same remote checkout currently being reconciled. */
function sameRemoteSource(entry: PluginSource, parsed: ReturnType<typeof parseSource>, ref: string | undefined): boolean {
  if (parsed.kind === "local") return false;
  if (entry.type !== "github") return false;
  return entry.repo === parsed.source && entry.ref === ref;
}

/**
 * Remove plugins from the same remote source that disappeared from the latest
 * desired set. This handles both source layout changes (one plugin splitting
 * into several differently named plugins) and an explicit narrowed reinstall
 * (`--plugin one` after previously installing `--all`) without leaving stale
 * runtime exports behind.
 */
function reconcileRemotePlugins(
  opts: AddOptions,
  parsed: ReturnType<typeof parseSource>,
  ref: string | undefined,
  desired: Set<string>,
): string[] {
  if (parsed.kind === "local") return [];
  // A sparse checkout does not prove the full source shape, so it must not
  // prune sibling plugins from the same repo that were intentionally excluded.
  if (opts.sparse?.length) return [];

  const lock = readLock(lockPath(opts.pluginsDir));
  const stale = Object.entries(lock.plugins)
    .filter(([name, entry]) => sameRemoteSource(entry.origin, parsed, ref) && !desired.has(name))
    .map(([name]) => name)
    .sort();

  if (stale.length === 0) return [];

  // Removing from the ADG store is target-agnostic: once a plugin is no longer
  // desired, every agent that may have cached it must be asked to drop it. The
  // install/refresh pass below still honors `targets`; this broader deactivation
  // only applies to removed store entries.
  const agents = opts.activate ? (opts.deactivationAgents ?? resolveAgents()) : undefined;
  for (const name of stale) {
    removePlugin({
      pluginsDir: opts.pluginsDir,
      name,
      force: true,
      deactivate: opts.activate,
      scope: opts.scope,
      agents,
    });
  }
  return stale;
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
  parsed: ReturnType<typeof parseSource>,
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

interface DefaultDslPlugin {
  candidates: Map<string, PluginCandidate>;
  converted: string[];
  structuralName: string;
  /** The real source dir, so `buildOrigin` points at it instead of the staging copy. */
  originDirOverride: string;
  definition: DefaultDefinitionProfile;
  cleanup: () => void;
}

/**
 * Synthesize a single Default DSL plugin from a source that holds no explicit
 * ADG/native manifest: generate a manifest for the whole tree, stage a copy
 * with it written in, and scan that staging copy as the sole candidate.
 */
async function synthesizeDefaultDslPlugin(
  opts: AddOptions,
  parsed: ReturnType<typeof parseSource>,
  workRoot: string,
  resolvedRevision: string | undefined,
): Promise<DefaultDslPlugin> {
  const defaultDescription =
    parsed.kind === "github" && !opts.preparedSourceDir && !opts.defaultDescription
      ? await githubRepositoryDescription(parsed.source)
      : undefined;
  const structuralIdentity = opts.as ?? opts.structuralIdentity ?? (parsed.kind === "github" ? parsed.source : basename(workRoot));
  const generated = resolveDefaultDsl(workRoot, {
    name: structuralIdentity,
    description: defaultDescription ?? opts.defaultDescription ?? structuralIdentity,
  }, {
    ...(parsed.kind === "github" && resolvedRevision ? { resolvedRevision } : {}),
  });
  const authorized = opts.authorizedComponents;
  const unauthorizedRisk = generated.components.some((c) => (c === "hooks" || c === "mcp") && !authorized?.includes(c));
  if (opts.nonInteractive && unauthorizedRisk && opts.only === undefined) {
    throw new Error("default source exposes hooks or MCP; pass --only to explicitly authorize selected components");
  }
  const staging = mkdtempSync(join(tmpdir(), "adg-default-plugin-"));
  let candidates: Map<string, PluginCandidate>;
  try {
    copyPluginDir(workRoot, staging);
    writeJson(join(staging, ADG_MANIFEST_PATH), generated.manifest);
    candidates = scanPlugins(staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    candidates,
    converted: [],
    structuralName: generated.manifest.name,
    originDirOverride: workRoot,
    definition: {
      kind: "default-dsl/v1",
      root: ".",
      ...(opts.as ? { as: generated.manifest.name } : {}),
      description: generated.manifest.description,
      fingerprint: generated.fingerprint,
      authorizedComponents: authorized ?? (opts.only ?? generated.components),
    },
    cleanup: () => rmSync(staging, { recursive: true, force: true }),
  };
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
  const parsed = opts.preparedSourceDir ? parseGitHubSource(opts.spec) : parseSource(opts.spec);
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
      cleanup = () => { synthesized.cleanup(); priorCleanup?.(); };
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
