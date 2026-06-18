import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { marketplacePath } from "../paths.ts";
import { readMarketplace } from "../marketplace.ts";
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

function available(): boolean {
  return spawnSync("codex", ["plugin", "--help"], { stdio: "ignore" }).status === 0;
}

function run(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("codex", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

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
