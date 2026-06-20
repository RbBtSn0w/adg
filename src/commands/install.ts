import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { ADAPTER_TARGETS, type AdapterTarget } from "../adapters/index.ts";
import { fromNativeManifest } from "../adapters/reverse.ts";
import { adaptPlugin } from "./adapt.ts";
import { copyPluginDir, toPosix, writeJson } from "../fsutil.ts";
import { folderHash } from "../hash.ts";
import { packageFilter, PROJECTION_DIRS } from "../package.ts";
import { lockPath, marketplacePath, marketplaceSourcePath, pluginDir } from "../paths.ts";
import { readLock, upsertEntry, writeLock } from "../lock.ts";
import { ADG_MANIFEST_PATH, readManifest } from "../manifest.ts";
import { readMarketplace, upsertMarketplacePlugin, writeMarketplace } from "../marketplace.ts";
import { resolveInstallOrder, type PluginCandidate } from "../deps.ts";
import { cloneGitHub, parseSource, scanNativePlugins, scanPlugins, type GitRunner } from "../sources.ts";
import { sameSource, COMPONENT_TYPES, type ComponentType, type LockEntry, type PluginSelection, type PluginSource } from "../types.ts";
import { pluginContents, presentComponents } from "../components.ts";
import { skillDescriptionLoader } from "../skills.ts";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";

export interface InstallOneOptions {
  /** Local directory containing the plugin (already fetched). */
  source: string;
  /** Destination plugins directory. */
  pluginsDir: string;
  /** Upstream provenance recorded in the lock; defaults to local copy-in. */
  origin?: PluginSource;
  marketplaceName?: string;
  targets?: AdapterTarget[];
  now?: string;
  /**
   * Partial-install selection narrowing what the generated manifests expose.
   * When omitted, a prior lock entry's selection is reused (so it survives
   * re-installs / upgrades); absent on both = expose everything.
   */
  selection?: PluginSelection;
}

export interface InstallResult {
  name: string;
  installedTo: string;
  folderHash: string;
  adapted: string[];
}

// Generated runtime projections never count toward a plugin's content hash.
const HASH_IGNORE = PROJECTION_DIRS;

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
  const manifest = readManifest(source);
  const name = manifest.name;
  // Local installs stay flat; remote sources derive a per-marketplace dir from
  // their origin. The default (no origin) is a flat local copy-in.
  const origin: PluginSource =
    opts.origin ?? { type: "local", path: `./${toPosix(name)}` };
  const dest = pluginDir(opts.pluginsDir, name, origin);

  // When the source already lives at the destination (e.g. adapting an
  // in-repo reference plugin) skip the copy to avoid copying onto itself.
  // Only the manifest-declared payload is copied (projections included) — dev
  // cruft like src/ or test/ never ships.
  if (resolve(dest) !== source) {
    copyPluginDir(source, dest, packageFilter(manifest, { includeProjections: true }));
  }

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
  const selection = opts.selection ?? prev?.selection;

  const targets = opts.targets ?? [...ADAPTER_TARGETS];
  const adapted = adaptPlugin(dest, targets, selection).map((r) => r.file);

  const hash = folderHash(dest, HASH_IGNORE, packageFilter(manifest, { includeProjections: false }));

  const entry: Omit<LockEntry, "installedAt" | "updatedAt"> = {
    origin,
    version: manifest.version,
    folderHash: hash,
  };
  if (manifest.dependencies?.length) {
    entry.dependencies = Object.fromEntries(manifest.dependencies.map((d) => [d.name, d.version]));
  }
  if (selection) entry.selection = selection;
  upsertEntry(lock, name, entry, opts.now);
  writeLock(lockFile, lock);

  const marketFile = marketplacePath(opts.pluginsDir);
  const fallbackName = opts.marketplaceName ?? basename(opts.pluginsDir);
  const market = readMarketplace(marketFile, fallbackName);
  // marketplace.json is a pure runtime-facing export in the de-facto shape;
  // version/integrity/provenance live in the lock, not here.
  upsertMarketplacePlugin(market, {
    name,
    source: { source: "local", path: marketplaceSourcePath(opts.pluginsDir, dest) },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    ...(manifest.category ? { category: manifest.category } : {}),
  });
  writeMarketplace(marketFile, market);

  return { name, installedTo: dest, folderHash: hash, adapted };
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
  /** Restrict a GitHub checkout to these sub-paths (sparse checkout). */
  sparse?: string[];
  /** Injectable git clone runner (for offline testing). */
  gitRunner?: GitRunner;

  // ── selection (a source may hold one plugin or a whole marketplace) ──
  /** Install every plugin found in the source. */
  all?: boolean;
  /** Install only these plugin names. */
  plugins?: string[];
  /** Install the single plugin at this sub-path. */
  path?: string;
  /** Resolve and install transitive plugin dependencies. Default true. */
  withDeps?: boolean;
  /**
   * Interactive picker, used only when the source holds multiple plugins and
   * none of all/plugins/path narrowed the selection. Returns chosen names.
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
  /**
   * Interactive gate (the "install everything?" question). Returning false
   * drops into per-plugin component selection. Skipped when only/skillsSubset
   * are set. Applies only to the user-chosen plugins, not auto-deps.
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
}

export interface AddResult {
  order: string[];
  installed: InstallResult[];
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
    const manifest = fromNativeManifest(raw, native.kind);
    writeJson(join(native.dir, ADG_MANIFEST_PATH), manifest);
    converted.push(manifest.name);
  }
  return { candidates: scanPlugins(root), converted };
}

/** Resolve which discovered plugins to install from the selection options. */
async function selectPluginNames(
  opts: AddOptions,
  candidates: Map<string, PluginCandidate>,
  workRoot: string,
  converted: string[],
): Promise<string[]> {
  const names = [...candidates.keys()];

  if (opts.plugins?.length) {
    const missing = opts.plugins.filter((p) => !candidates.has(p));
    if (missing.length) {
      throw new Error(`plugin(s) not found in source: ${missing.join(", ")}.\nAvailable: ${names.join(", ")}`);
    }
    return opts.plugins;
  }
  if (opts.path) {
    const target = resolve(join(workRoot, opts.path));
    const hit = [...candidates.values()].find((c) => resolve(c.dir) === target);
    if (!hit) throw new Error(`no plugin found at --path ${opts.path}`);
    return [hit.manifest.name];
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

  if (opts.only || opts.skillsSubset) {
    const flagSelection: PluginSelection = {
      components: opts.only ?? [...COMPONENT_TYPES],
      ...(opts.skillsSubset ? { skills: opts.skillsSubset } : {}),
    };
    for (const name of selected) selections.set(name, flagSelection);
    return selections;
  }

  if (!opts.confirmFull || !opts.selectComponents) return selections; // non-interactive default: full
  if (await opts.confirmFull(selected)) return selections; // user kept everything

  for (const name of selected) {
    const cand = candidates.get(name)!;
    const contents = pluginContents(cand.dir, cand.manifest);
    const present = presentComponents(contents);
    // Nothing meaningful to pick: a lone category with at most one member.
    if (present.length <= 1 && contents.skills.length <= 1) continue;
    const skillDescription = skillDescriptionLoader(cand.dir, cand.manifest);
    selections.set(name, await opts.selectComponents({ name, contents, present, skillDescription }));
  }
  return selections;
}

/**
 * The unified install entrypoint. Treats any source as a marketplace: clone or
 * read it, discover every plugin (ADG plus reverse-adapted native), choose a
 * subset (--all / --plugin / --path / sole plugin / interactive picker), then
 * install the selection in dependency-first order.
 */
export async function addPlugins(opts: AddOptions): Promise<AddResult> {
  const parsed = parseSource(opts.spec);
  let workRoot: string;
  let buildOrigin: (dir: string) => PluginSource;
  let cleanup: (() => void) | undefined;

  if (parsed.kind === "local") {
    workRoot = resolve(parsed.dir);
    buildOrigin = (dir) => ({ type: "local", path: `./${toPosix(relative(workRoot, dir)) || basename(dir)}` });
  } else {
    const ref = opts.ref ?? parsed.ref;
    const tmp = mkdtempSync(join(tmpdir(), "adg-clone-"));
    cleanup = () => rmSync(tmp, { recursive: true, force: true });
    cloneGitHub({ ...parsed, ref }, tmp, { sparse: opts.sparse, runner: opts.gitRunner });
    workRoot = tmp;
    buildOrigin = (dir) => ({
      type: "github",
      repo: parsed.source,
      ...(ref ? { ref } : {}),
      path: toPosix(relative(tmp, dir)) || ".",
    });
  }

  try {
    const { candidates, converted } = discoverPlugins(workRoot);
    if (candidates.size === 0) {
      throw new Error(
        `no plugin found in "${opts.spec}" (no .agents/.plugin.json, .claude-plugin or .codex-plugin manifest).`,
      );
    }

    const selected = await selectPluginNames(opts, candidates, workRoot, converted);
    if (selected.length === 0) throw new Error("no plugins selected");

    // Resolve adapter targets after the plugin choice (lets a CLI agent picker
    // run once we know what's being installed). undefined → installPlugin's all.
    const targets = opts.targets ?? (opts.selectTargets ? await opts.selectTargets() : undefined);

    // Partial-install selection per user-chosen plugin (auto-deps install full).
    const selections = await resolveSelections(opts, selected, candidates);

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

    const installed: InstallResult[] = [];
    for (const name of order) {
      const candidate = candidates.get(name)!;
      installed.push(
        installPlugin({
          source: candidate.dir,
          pluginsDir: opts.pluginsDir,
          origin: buildOrigin(candidate.dir),
          marketplaceName: opts.marketplaceName,
          targets,
          selection: selections.get(name),
          now: opts.now,
        }),
      );
    }
    // Activate into the selected agents so the plugins are actually usable, not
    // just recorded/discoverable — each agent enables them via its own CLI.
    // undefined targets = all registered agents.
    let agents: AgentSyncResult[] | undefined;
    if (opts.activate) {
      const ctx = { pluginsDir: opts.pluginsDir, plugins: installed.map((r) => r.name), scope: opts.scope ?? "project" };
      agents = (opts.agents ?? resolveAgents(targets)).map((a) => a.activate(ctx));
    }

    return { order, installed, converted, available: [...candidates.keys()], agents };
  } finally {
    cleanup?.();
  }
}
