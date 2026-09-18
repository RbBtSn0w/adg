import { allAgents, resolveAgents, type Agent } from "../agents/index.ts";
import type { AgentPruneResult } from "../agents/types.ts";
import type { AdapterTarget } from "../adapters/index.ts";

export interface PruneAgentsOptions {
  /** Restrict to these agents; omitted = every registered agent. */
  targets?: AdapterTarget[];
  /** Injection seam for tests; defaults to the resolved/all agents. */
  agents?: Agent[];
}

/**
 * `adg plugins prune` — ask every resolved agent to remove its own ADG-owned
 * registrations (marketplaces, cached snapshots, …) that still point at a
 * plugin directory ADG no longer has on disk. Read-only for agents that don't
 * implement `pruneStale` (which report back `skipped: true`).
 */
export function pruneAgents(opts: PruneAgentsOptions = {}): AgentPruneResult[] {
  const agents = opts.agents ?? (opts.targets ? resolveAgents(opts.targets) : allAgents());
  return agents.map((agent) => agent.pruneStale?.() ?? { agent: agent.id, skipped: true, removed: [], errors: [] });
}

/**
 * Whether `adg plugins prune` should exit non-zero: a stale registration was
 * found but ADG couldn't clean it up (the agent's CLI rejected the removal,
 * etc). This is a real failure of this mutating command — unlike `status`,
 * which reports drift at exit 0 because finding it IS the successful outcome
 * of a read-only diagnostic.
 */
export function pruneHasErrors(results: AgentPruneResult[]): boolean {
  return results.some((r) => r.errors.length > 0);
}
