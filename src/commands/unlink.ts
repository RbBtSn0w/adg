import { listPlugins } from "./list.ts";
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
  if (!agent) return { target: opts.target, unlinked: [] };

  const scope = opts.global ? "user" : "project";
  const installedInAgent = agent.listInstalled?.({ pluginsDir: opts.pluginsDir, plugins: [], scope });
  const installedInStore = listPlugins(opts.pluginsDir).map((p) => p.name);

  // A name is valid if it is installed in either the store OR the agent (if queryable).
  const validNames = new Set([...installedInStore, ...(installedInAgent ?? [])]);

  const names = opts.names && opts.names.length > 0
    ? opts.names
    : installedInStore;

  if (opts.names && opts.names.length > 0) {
    const missing = opts.names.filter((n) => !validNames.has(n));
    if (missing.length > 0) {
      throw new Error(`not installed: ${missing.join(", ")}. See \`adg plugins list\`.`);
    }
  }

  // Only filter if we successfully queried the agent's installed plugins.
  // Otherwise, fall back to always calling deactivate for the selected names.
  const toUnlink = installedInAgent !== undefined
    ? names.filter((n) => installedInAgent.includes(n))
    : names;

  if (toUnlink.length === 0 && installedInAgent !== undefined) {
    return { target: opts.target, unlinked: [], cliSkipped: false };
  }

  const res = agent.deactivate({
    pluginsDir: opts.pluginsDir,
    plugins: toUnlink,
    scope,
  });
  return { target: opts.target, unlinked: res.affected, cliSkipped: res.skipped };
}

