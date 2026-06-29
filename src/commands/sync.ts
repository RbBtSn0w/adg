import { existsSync } from "node:fs";
import { adaptPlugin } from "./adapt.ts";
import { selectInstalled } from "./projection.ts";
import { installedPluginDir } from "../paths.ts";
import { getAgent, type Agent } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";

/**
 * `adg plugins sync` — reconcile one agent's copy of the selected plugins to the
 * store. Regenerate each plugin's manifest (honoring its partial-install
 * selection), then drive the agent's `refresh`, which uninstalls before
 * re-importing so components dropped since the last sync don't linger. This is
 * the repair verb: when an agent has drifted (e.g. residual skills left by a
 * merge-style install), `sync --target X <name>` makes it match the store again.
 *
 * Unlike a blanket prune, sync only touches plugins the store knows about, so a
 * plugin you installed into the agent outside ADG is never disturbed.
 */

export interface SyncOptions {
  /** Source plugins directory (where installed plugins live). */
  pluginsDir: string;
  target: AdapterTarget;
  /** Use the user (global) scope instead of project scope. */
  global?: boolean;
  /** Limit to these plugin names; omitted = every installed plugin. */
  names?: string[];
  /** Injection seam for tests; defaults to the registered agent for `target`. */
  agent?: Agent;
}

export interface SyncAction {
  name: string;
  /** Adapter manifest(s) regenerated for the target. */
  adapted: string[];
  /** True when the agent re-synced this plugin. */
  synced: boolean;
}

export interface SyncResult {
  target: AdapterTarget;
  actions: SyncAction[];
  /** True when the target agent's CLI was missing (manifests regenerated, nothing re-synced). */
  cliSkipped?: boolean;
}

/** Regenerate manifests for the selected plugins, then refresh them in the agent. */
export function syncPlugins(opts: SyncOptions): SyncResult {
  const agent = opts.agent ?? getAgent(opts.target);
  const adaptTarget = agent?.adaptTarget ?? opts.target;

  const actions: SyncAction[] = [];
  for (const p of selectInstalled(opts.pluginsDir, opts.names)) {
    const dir = installedPluginDir(opts.pluginsDir, p.name, p.origin);
    if (!existsSync(dir)) continue;
    const adapted = adaptPlugin(dir, [adaptTarget], p.selection).map((r) => r.file);
    actions.push({ name: p.name, adapted, synced: false });
  }

  if (!agent) return { target: opts.target, actions };

  const res = agent.refresh({
    pluginsDir: opts.pluginsDir,
    plugins: actions.map((a) => a.name),
    scope: opts.global ? "user" : "project",
  });
  for (const a of actions) if (res.affected.includes(a.name)) a.synced = true;
  return { target: opts.target, actions, cliSkipped: res.skipped };
}
