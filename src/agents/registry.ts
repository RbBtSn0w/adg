import { ADAPTER_COMPONENTS } from "../adapters/index.ts";
import type { ComponentType } from "../types.ts";
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

/**
 * Registered agents whose adapter can express at least one of the given exposed
 * component types — i.e. the agents a plugin is adaptable to. An empty `types`
 * (no manifest / nothing exposed) can't be proven incompatible, so all agents
 * are returned.
 */
export function agentsForComponents(types: ComponentType[]): Agent[] {
  if (types.length === 0) return allAgents();
  return allAgents().filter((a) => (ADAPTER_COMPONENTS[a.adaptTarget] ?? []).some((c) => types.includes(c)));
}

/** Agents matching the given ids, or every registered agent when none are given. */
export function resolveAgents(targets?: readonly AgentId[]): Agent[] {
  if (!targets) return allAgents();
  return targets.map((t) => getAgent(t)).filter((a): a is Agent => a !== undefined);
}
