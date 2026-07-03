import { existsSync } from "node:fs";
import { adaptPlugin } from "./adapt.ts";
import { listPlugins } from "./list.ts";
import { agentsForComponents, resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";
import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock, writeLock } from "../lock.ts";
import { pluginState, type ComponentType, type PluginLock, type PluginState } from "../types.ts";

export interface PluginStateOptions {
  pluginsDir: string;
  names: string[];
  scope: AgentScope;
  agents?: Agent[];
}

export interface PluginStateChangeResult {
  state: PluginState;
  order: string[];
  changed: string[];
  agents: AgentSyncResult[];
}

function selectedLock(opts: PluginStateOptions): { lock: PluginLock; names: string[] } {
  const lock = readLock(lockPath(opts.pluginsDir));
  const names = [...new Set(opts.names)];
  const missing = names.filter((name) => !lock.plugins[name]);
  if (missing.length > 0) throw new Error(`not installed: ${missing.join(", ")}. See \`adg plugins list\`.`);
  return { lock, names };
}

function enabledDependents(lock: PluginLock, names: Set<string>): string[] {
  return Object.entries(lock.plugins)
    .filter(([name, entry]) => !names.has(name) && pluginState(entry) === "enabled" && Object.keys(entry.dependencies ?? {}).some((dep) => names.has(dep)))
    .map(([name]) => name)
    .sort();
}

function enableOrder(lock: PluginLock, roots: string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = lock.plugins[name];
    if (!entry) throw new Error(`missing installed dependency: ${name}`);
    for (const dependency of Object.keys(entry.dependencies ?? {}).sort()) visit(dependency);
    order.push(name);
  };
  for (const root of roots) visit(root);
  return order;
}

function pluginAgentIds(pluginsDir: string, name: string): Set<string> {
  const plugin = listPlugins(pluginsDir).find((item) => item.name === name);
  const types = Object.entries(plugin?.contents ?? {})
    .filter(([, members]) => members.length > 0)
    .map(([type]) => type as ComponentType);
  return new Set(agentsForComponents(types).map((agent) => agent.id));
}

export function disablePlugins(opts: PluginStateOptions): PluginStateChangeResult {
  const { lock, names } = selectedLock(opts);
  const requested = new Set(names);
  const dependents = enabledDependents(lock, requested);
  if (dependents.length > 0) throw new Error(`required by enabled plugin(s): ${dependents.join(", ")}`);

  const changed = names.filter((name) => pluginState(lock.plugins[name]!) !== "disabled");
  for (const name of names) lock.plugins[name]!.state = "disabled";
  if (changed.length > 0) writeLock(lockPath(opts.pluginsDir), lock);

  const ctx = { pluginsDir: opts.pluginsDir, plugins: names, scope: opts.scope };
  const agents = (opts.agents ?? resolveAgents()).map((agent) => agent.deactivate(ctx));
  return { state: "disabled", order: names, changed, agents };
}

export function enablePlugins(opts: PluginStateOptions): PluginStateChangeResult {
  const { lock, names } = selectedLock(opts);
  const order = enableOrder(lock, names);
  const changed = order.filter((name) => pluginState(lock.plugins[name]!) !== "enabled");
  for (const name of order) lock.plugins[name]!.state = "enabled";
  if (changed.length > 0) writeLock(lockPath(opts.pluginsDir), lock);

  const agents = (opts.agents ?? resolveAgents()).map((agent) => {
    const compatible = order.filter((name) => pluginAgentIds(opts.pluginsDir, name).has(agent.id));
    for (const name of compatible) {
      const entry = lock.plugins[name]!;
      const dir = installedPluginDir(opts.pluginsDir, name, entry.origin);
      if (existsSync(dir)) adaptPlugin(dir, [agent.adaptTarget], entry.selection);
    }
    return agent.activate({ pluginsDir: opts.pluginsDir, plugins: compatible, scope: opts.scope });
  });
  return { state: "enabled", order, changed, agents };
}
