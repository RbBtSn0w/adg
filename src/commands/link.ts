import { existsSync } from "node:fs";
import { adaptPlugin } from "./adapt.ts";
import { listPlugins } from "./list.ts";
import { installedPluginDir } from "../paths.ts";
import { getAgent, type Agent } from "../agents/index.ts";

export type LinkTarget = "claude" | "codex";

export interface LinkOptions {
  /** Source plugins directory (where installed plugins live). */
  pluginsDir: string;
  target: LinkTarget;
  /** Use the user (global) scope instead of project scope. */
  global?: boolean;
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

  const actions: LinkAction[] = [];
  for (const p of listPlugins(opts.pluginsDir)) {
    const dir = installedPluginDir(opts.pluginsDir, p.name, p.origin);
    if (!existsSync(dir)) continue;
    const adapted = adaptPlugin(dir, [adaptTarget], p.selection).map((r) => r.file);
    actions.push({ name: p.name, adapted });
  }

  if (!agent) return { target: opts.target, actions };

  const res = agent.activate({
    pluginsDir: opts.pluginsDir,
    plugins: actions.map((a) => a.name),
    scope: opts.global ? "user" : "project",
  });
  for (const a of actions) if (res.affected.includes(a.name)) a.linkedTo = agent.displayName;
  return { target: opts.target, actions, cliSkipped: res.skipped };
}
