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

/** A live plugin query reached the agent CLI, but the CLI rejected the query. */
export interface AgentListFailure {
  error: string;
  /** Optional command that repairs a recognized, safely recoverable failure. */
  recoveryCommand?: string;
}

export type AgentListResult = string[] | AgentListFailure | undefined;

export function isAgentListFailure(result: AgentListResult): result is AgentListFailure {
  return result !== undefined && !Array.isArray(result);
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
  /**
   * Best-effort list of the plugin names this agent currently has enabled, by
   * querying its CLI. Powers `adg plugins status`'s drift detection. Returns
   * `undefined` (not `[]`) when the agent's CLI is absent, or an explicit
   * `AgentListFailure` when the CLI rejects the query, so "unknown" is never
   * confused with "nothing installed". `ctx` lets an agent scope the query
   * (e.g. to its own marketplace). Optional: an agent that can't enumerate its
   * plugins simply omits it.
   */
  listInstalled?(ctx: AgentContext): AgentListResult;
}
