import type { Span } from "@opentelemetry/api";
import type { AdapterTarget } from "../../adapters/index.ts";
import type { ComponentType, DefaultDefinitionProfile, PluginSelection, PluginSource } from "../../types.ts";
import type { GitRunner } from "../../sources.ts";
import type { UpdatePhase } from "../../render/progress.ts";
import type { Agent, AgentScope, AgentSyncResult } from "../../agents/index.ts";
import type { PluginContents } from "../../components.ts";

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
  telemetrySpan?: Pick<Span, "addEvent">;
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

export interface ResolvedInstallOrder {
  order: string[];
  /** Topological batches that can be installed concurrently. */
  batches: string[][];
  missing: string[];
}

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
  contents: PluginContents;
  /** Categories the plugin actually has (non-empty). */
  present: ComponentType[];
  /** Lazy, cached `description` lookup for a skill (drives the on-demand toggle). */
  skillDescription?: (name: string) => string | undefined;
}

export interface AddOptions {
  /** Local path or owner/repo[@ref] / github URL. */
  spec: string;
  pluginsDir: string;
  /** Working directory to resolve relative local paths against; defaults to process.cwd(). */
  cwd?: string;
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
