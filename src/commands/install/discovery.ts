import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromNativeManifest } from "../../adapters/reverse.ts";
import { writeJson } from "../../fsutil.ts";
import { lockPath } from "../../paths.ts";
import { readLock } from "../../lock.ts";
import { ADG_MANIFEST_PATH } from "../../manifest.ts";
import { scanNativePlugins, scanPlugins, type ParsedSource } from "../../sources.ts";
import type { PluginCandidate } from "../../deps.ts";
import {
  COMPONENT_TYPES,
  type PluginSelection,
  type PluginSource,
} from "../../types.ts";
import { pluginContents, presentComponents } from "../../components.ts";
import { skillDescriptionLoader } from "../../skills.ts";
import { resolveAgents } from "../../agents/index.ts";
import { removePlugin } from "../remove.ts";
import type { AddOptions, PluginChoice } from "./types.ts";

/**
 * Reverse-adapt any native (Claude/Codex) manifests under `root` into
 * `.agents/.plugin.json`, then return every ADG plugin found. After this the
 * whole source speaks ADG, so selection and install treat all plugins uniformly.
 */
export function discoverPlugins(root: string): { candidates: Map<string, PluginCandidate>; converted: string[] } {
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
export async function selectPluginNames(
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
export async function resolveSelections(
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
export function sameRemoteSource(entry: PluginSource, parsed: ParsedSource, ref: string | undefined): boolean {
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
export function reconcileRemotePlugins(
  opts: AddOptions,
  parsed: ParsedSource,
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
