import { adaptedFilesForTarget, rematerializeInstalled, selectInstalled } from "./projection.ts";
import { getAgent, type Agent } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";
import { pluginState } from "../types.ts";

/** A single runtime to link into. Any registered adapter target (claude/codex/antigravity). */
export type LinkTarget = AdapterTarget;

export interface LinkOptions {
  /** Source plugins directory (where installed plugins live). */
  pluginsDir: string;
  target: LinkTarget;
  /** Use the user (global) scope instead of project scope. */
  global?: boolean;
  /** Limit to these plugin names; omitted = every installed plugin. */
  names?: string[];
  /** Injection seam for tests; defaults to the registered agent for `target`. */
  agent?: Agent;
}

export interface LinkAction {
  name: string;
  /** Adapter manifest(s) (re)generated. */
  adapted: string[];
  /** The agent the plugin was enabled in, if activation succeeded. */
  linkedTo?: string;
}

export interface LinkResult {
  target: LinkTarget;
  actions: LinkAction[];
  /** True when the target agent's CLI was missing (manifests written, nothing enabled). */
  cliSkipped?: boolean;
}

/**
 * Project installed plugins into an agent: (re)generate that agent's manifest
 * from each plugin (honoring its partial-install selection), then enable the
 * plugins through the agent's CLI. The pure manifest transform comes from
 * `ADAPTERS[agent.adaptTarget]`; the enable step is the agent's `activate`.
 */
export function linkPlugins(opts: LinkOptions): LinkResult {
  const agent = opts.agent ?? getAgent(opts.target);
  const adaptTarget = agent?.adaptTarget ?? opts.target;

  const selected = selectInstalled(opts.pluginsDir, opts.names);
  const disabled = selected.filter((p) => pluginState(p) === "disabled");
  if (opts.names && disabled.length > 0) {
    const names = disabled.map((p) => p.name);
    throw new Error(`disabled plugin(s): ${names.join(", ")}. Run \`adg plugins enable ${names.join(" ")}\`.`);
  }
  const enabled = selected.filter((p) => pluginState(p) === "enabled");
  const actions: LinkAction[] = rematerializeInstalled(opts.pluginsDir, enabled)
    .map((result) => ({ name: result.name, adapted: adaptedFilesForTarget(result.installedTo, result.adapted, adaptTarget) }));

  if (!agent) return { target: opts.target, actions };
  if (actions.length === 0) return { target: opts.target, actions };

  const res = agent.activate({
    pluginsDir: opts.pluginsDir,
    plugins: actions.map((a) => a.name),
    scope: opts.global ? "user" : "project",
    ...(opts.target === "codex" ? { reconcileLegacyAliases: true } : {}),
  });
  for (const a of actions) if (res.affected.includes(a.name)) a.linkedTo = agent.displayName;
  return { target: opts.target, actions, cliSkipped: res.skipped };
}
