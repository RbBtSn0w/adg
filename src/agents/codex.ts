import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { marketplacePath } from "../paths.ts";
import { readMarketplace } from "../marketplace.ts";
import { makeCli } from "./base.ts";
import type { Agent, AgentContext, AgentSyncResult } from "./types.ts";

/**
 * Codex agent.
 *
 * Codex natively discovers the `.agents/plugins/marketplace.json` ADG writes, so
 * plugins show up as *available* — but aren't usable until installed with
 * `codex plugin add`. We drive that via the `codex` CLI (which owns ~/.codex).
 */

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

const { available, run } = makeCli("codex", { probeArgs: ["plugin", "--help"] });

/** The marketplace name Codex sees, read from the generated marketplace.json. */
function marketplaceName(pluginsDir: string): string {
  return readMarketplace(marketplacePath(pluginsDir), "").name;
}

export const codexAgent: Agent = {
  id: "codex",
  displayName: "Codex",
  adaptTarget: "codex",
  detect: (env = process.env) => existsSync(codexHome(env)) || existsSync("/etc/codex"),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    const mp = marketplaceName(ctx.pluginsDir);
    if (!available()) return { agent: "codex", affected: [], skipped: true };
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "add", `${p}@${mp}`]).ok) affected.push(p);
    }
    return { agent: "codex", affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    const mp = marketplaceName(ctx.pluginsDir);
    if (!available()) return { agent: "codex", affected: [], skipped: true };
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "remove", `${p}@${mp}`]).ok) affected.push(p);
    }
    return { agent: "codex", affected, skipped: false };
  },

  // `codex plugin add` is idempotent and re-copies into the cache, so re-adding
  // is the refresh.
  refresh(ctx: AgentContext): AgentSyncResult {
    return codexAgent.activate(ctx);
  },
};
