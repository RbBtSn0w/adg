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

  // `codex plugin add` stages into `.remote-plugin-install-staging` and swaps the
  // cache entry (keeping a `.tmp/plugins-backup-*`), so it *replaces* rather than
  // merges — re-adding is a clean, atomic refresh with no stale-component residue.
  // (Contrast agy, whose `install` merges and so needs an explicit uninstall.)
  refresh(ctx: AgentContext): AgentSyncResult {
    return codexAgent.activate(ctx);
  },

  // Query Codex's live plugin state for `adg plugins status`, scoped to our
  // generated marketplace. `available()` gates the query so an absent CLI is a
  // quiet `undefined` ("unknown").
  listInstalled(ctx: AgentContext): string[] | undefined {
    if (!available()) return undefined;
    const mp = marketplaceName(ctx.pluginsDir);
    if (!mp) return undefined; // no generated marketplace → can't scope the query
    const res = run(["plugin", "list"]);
    if (!res.ok) return undefined;
    return parseCodexPluginList(res.out, mp);
  },
};

/**
 * Parse `codex plugin list` output into the *installed and enabled* plugin names
 * from a given marketplace. The listing is a whitespace-aligned table whose
 * columns are `<name>@<marketplace>`, `STATUS` (e.g. "installed, enabled"),
 * `VERSION`, `PATH`. We split on 2+ spaces and read the STATUS column so that
 * an available-but-not-added or disabled row isn't miscounted as live, and the
 * header / banner / path lines (no `name@mp` first column) are skipped. Pure
 * (no CLI) so it is unit-testable against captured output.
 */
export function parseCodexPluginList(out: string, marketplace: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of out.split("\n")) {
    const cols = line.split(/\s{2,}/);
    const head = cols[0]?.match(/^(\S+?)@(\S+)$/);
    if (!head || head[2] !== marketplace) continue;
    const status = (cols[1] ?? "").toLowerCase();
    // Count only plugins actually added and active; "disabled" never contains
    // "enabled", so the substring tests cleanly separate the states.
    if (!status.includes("installed") || status.includes("disabled")) continue;
    if (!seen.has(head[1]!)) {
      seen.add(head[1]!);
      names.push(head[1]!);
    }
  }
  return names;
}
