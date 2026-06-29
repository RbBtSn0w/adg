import { existsSync } from "node:fs";
import { listPlugins } from "./list.ts";
import { allAgents, isAgentListFailure, resolveAgents, type Agent, type AgentScope } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";
import { lockPath } from "../paths.ts";

/**
 * `adg plugins status` — compare the store against what each agent actually has
 * enabled (queried live from its CLI), so drift is visible and each row carries
 * the command that repairs it.
 *
 * Honest limitation: this is a name-level diff. It catches "in the store but not
 * the agent" and "in the agent but not the store", but cannot see *component*
 * drift (e.g. a residual skill inside a plugin that's present in both) — when in
 * doubt, `adg plugins sync` is the safe reconcile.
 */

export interface AgentStatus {
  id: string;
  displayName: string;
  /** False when the agent's CLI couldn't be queried — state is unknown. */
  queryable: boolean;
  /** Agent CLI diagnostic when the query ran but failed. */
  queryError?: string;
  /** Safe recovery command for a recognized query failure. */
  recoveryCommand?: string;
  /** In the store and enabled in the agent. */
  inSync: string[];
  /** In the store but not enabled in the agent → needs `link`/`sync`. */
  missing: string[];
  /** Enabled in the agent but absent from the store → possible orphan → `unlink`. */
  agentOnly: string[];
}

export interface StatusOptions {
  pluginsDir: string;
  scope: AgentScope;
  /** Restrict to these agents; omitted = every registered agent. */
  targets?: AdapterTarget[];
  /** Injection seam for tests; defaults to the resolved/all agents. */
  agents?: Agent[];
}

/** Diff the store against each agent's live plugin list. Read-only. */
export function pluginStatus(opts: StatusOptions): AgentStatus[] {
  const store = listPlugins(opts.pluginsDir).map((p) => p.name);
  const storeSet = new Set(store);
  // Query every registered agent (not just `detect`ed ones): `detect` is a
  // config-dir heuristic that can miss an installed CLI, and an agent that
  // can't be queried reports "unknown" anyway — so this never silently drops one.
  const agents = opts.agents ?? (opts.targets ? resolveAgents(opts.targets) : allAgents());

  const hasProjectLock = existsSync(lockPath(opts.pluginsDir));

  return agents.map((a) => {
    const installed = a.listInstalled?.({ pluginsDir: opts.pluginsDir, plugins: [], scope: opts.scope });
    if (installed === undefined) {
      return { id: a.id, displayName: a.displayName, queryable: false, inSync: [], missing: [], agentOnly: [] };
    }
    if (isAgentListFailure(installed)) {
      return {
        id: a.id,
        displayName: a.displayName,
        queryable: false,
        queryError: installed.error,
        recoveryCommand: installed.recoveryCommand,
        inSync: [],
        missing: [],
        agentOnly: [],
      };
    }
    const agentSet = new Set(installed);

    // If we're in project scope and the project doesn't have an ADG lock file,
    // the project is not initialized with ADG plugins. We should not report global
    // or other projects' plugins as "agent only" since they are unrelated.
    const agentOnly = (opts.scope === "project" && !hasProjectLock)
      ? []
      : installed.filter((n) => !storeSet.has(n));

    return {
      id: a.id,
      displayName: a.displayName,
      queryable: true,
      inSync: store.filter((n) => agentSet.has(n)),
      missing: store.filter((n) => !agentSet.has(n)),
      agentOnly,
    };
  });
}
