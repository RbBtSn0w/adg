import type { AdapterTarget } from "../adapters/index.ts";

/** Identifier for an agent ADG can install plugins into ("claude", "codex", or a third-party id). */
export type AgentId = string;

/** Install scope within an agent. Codex is global-only and ignores it. */
export type AgentScope = "user" | "project";

/** What an agent operation acts on. Agents derive their own specifics (marketplace name, …). */
export interface AgentContext {
  pluginsDir: string;
  plugins: string[];
  scope: AgentScope;
}

/** Outcome of one agent lifecycle call. */
export interface AgentSyncResult {
  agent: AgentId;
  /** Plugins enabled / disabled / refreshed. */
  affected: string[];
  /** True when the agent's CLI wasn't present, so the op was skipped (never a hard failure). */
  skipped: boolean;
}

/**
 * The runtime-integration contract every agent implements. The pure manifest
 * transform stays in `src/adapters` and is *composed* via `adaptTarget` — agents
 * own only the side-effectful lifecycle (detect / available / activate / …).
 *
 * Adding an agent (including third-party) = implement this + `registerAgent()`.
 */
export interface Agent {
  id: AgentId;
  displayName: string;
  /** Manifest format to generate for this agent (keys into `ADAPTERS`). */
  adaptTarget: AdapterTarget;
  /** Whether the agent appears installed on this machine (config dir present). */
  detect(env?: NodeJS.ProcessEnv): boolean;
  /** Whether the agent's CLI is usable. */
  available(): boolean;
  /** Enable/install the plugins in the agent. */
  activate(ctx: AgentContext): AgentSyncResult;
  /** Uninstall the plugins from the agent. */
  deactivate(ctx: AgentContext): AgentSyncResult;
  /** Refresh the agent's cached copy after the store changed. */
  refresh(ctx: AgentContext): AgentSyncResult;
}
