import type { Agent, AgentId } from "./types.ts";

/**
 * The agent registry — the "factory": construction/lookup only. Orchestration
 * (looping, dependency order, store writes) stays in the command layer.
 */
const REGISTRY = new Map<AgentId, Agent>();

export function registerAgent(agent: Agent): void {
  REGISTRY.set(agent.id, agent);
}

export function getAgent(id: AgentId): Agent | undefined {
  return REGISTRY.get(id);
}

export function allAgents(): Agent[] {
  return [...REGISTRY.values()];
}

/** Agents that appear installed on this machine. */
export function detectedAgents(env?: NodeJS.ProcessEnv): Agent[] {
  return allAgents().filter((a) => a.detect(env));
}

/** Agents matching the given ids, or every registered agent when none are given. */
export function resolveAgents(targets?: readonly AgentId[]): Agent[] {
  if (!targets) return allAgents();
  return targets.map((t) => getAgent(t)).filter((a): a is Agent => a !== undefined);
}
