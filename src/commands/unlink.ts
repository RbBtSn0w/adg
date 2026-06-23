import { selectInstalled } from "./projection.ts";
import { getAgent, type Agent } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";

/**
 * `adg plugins unlink` — the inverse of `link`. Deactivate plugins from a single
 * agent (via its CLI's uninstall), leaving the ADG store untouched: the plugins
 * stay installed and recorded, just no longer projected into that agent. This is
 * the per-agent control that `remove` (which deletes from the store and every
 * agent) deliberately doesn't offer.
 */

export interface UnlinkOptions {
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

export interface UnlinkResult {
  target: AdapterTarget;
  /** Plugins the agent actually disabled. */
  unlinked: string[];
  /** True when the target agent's CLI was missing (nothing was disabled). */
  cliSkipped?: boolean;
}

/**
 * Deactivate the selected plugins from one agent. Store/lock/marketplace catalog
 * are never touched — only the agent's own enabled state changes.
 */
export function unlinkPlugins(opts: UnlinkOptions): UnlinkResult {
  const agent = opts.agent ?? getAgent(opts.target);
  // Resolve (and validate) the names against the store even when no agent is
  // registered, so a typo still errors rather than silently no-op'ing.
  const names = selectInstalled(opts.pluginsDir, opts.names).map((p) => p.name);
  if (!agent) return { target: opts.target, unlinked: [] };

  const res = agent.deactivate({
    pluginsDir: opts.pluginsDir,
    plugins: names,
    scope: opts.global ? "user" : "project",
  });
  return { target: opts.target, unlinked: res.affected, cliSkipped: res.skipped };
}
