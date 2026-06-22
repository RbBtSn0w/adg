import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { toPosix, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { makeCli } from "./base.ts";
import type { Agent, AgentContext, AgentSyncResult } from "./types.ts";

/**
 * Claude Code agent.
 *
 * Claude consumes plugins through its own marketplace system, so we emit a
 * Claude-shaped catalog at `<pluginsDir>/.claude-plugin/marketplace.json` and
 * drive everything through the `claude plugin` CLI (which owns ~/.claude across
 * versions) rather than hand-editing Claude's internal state.
 */

const MARKETPLACE = "adg";

function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

const { available, run } = makeCli("claude", { probeArgs: ["plugin", "--help"] });

/**
 * Write a Claude marketplace catalog listing every installed plugin, each
 * `source` pointing at its on-disk directory (relative to the catalog).
 */
export function writeClaudeCatalog(pluginsDir: string, name: string = MARKETPLACE): { file: string; name: string } {
  const lock = readLock(lockPath(pluginsDir));
  const plugins: Record<string, unknown>[] = [];

  for (const [pname, entry] of Object.entries(lock.plugins)) {
    const dir = installedPluginDir(pluginsDir, pname, entry.origin);
    let description = "";
    let author: unknown;
    let category: string | undefined;
    try {
      const m = readManifest(dir);
      description = m.description;
      author = m.author;
      category = m.category;
    } catch {
      // no manifest on disk — list it minimally so the catalog stays complete
    }
    const rel = toPosix(relative(pluginsDir, dir)) || pname;
    plugins.push({
      name: pname,
      description,
      source: `./${rel}`,
      ...(author ? { author } : {}),
      ...(category ? { category } : {}),
    });
  }

  const catalog = {
    $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
    name,
    description: "ADG-managed plugins",
    owner: { name: "ADG" },
    plugins,
  };
  const file = join(pluginsDir, ".claude-plugin", "marketplace.json");
  writeJson(file, catalog);
  return { file, name };
}

/** Register the ADG store as a Claude marketplace (add, or update if present). */
function syncMarketplace(pluginsDir: string): void {
  const list = run(["plugin", "marketplace", "list"]);
  if (list.ok && list.out.includes(MARKETPLACE)) run(["plugin", "marketplace", "update", MARKETPLACE]);
  else run(["plugin", "marketplace", "add", pluginsDir]);
}

export const claudeAgent: Agent = {
  id: "claude",
  displayName: "Claude Code",
  adaptTarget: "claude",
  detect: (env = process.env) => existsSync(claudeHome(env)),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return { agent: "claude", affected: [], skipped: true };
    writeClaudeCatalog(ctx.pluginsDir);
    syncMarketplace(ctx.pluginsDir);
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "install", `${p}@${MARKETPLACE}`, "--scope", ctx.scope]).ok) affected.push(p);
    }
    return { agent: "claude", affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return { agent: "claude", affected: [], skipped: true };
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "uninstall", p, "--scope", ctx.scope]).ok) affected.push(p);
    }
    return { agent: "claude", affected, skipped: false };
  },

  refresh(ctx: AgentContext): AgentSyncResult {
    if (!available()) return { agent: "claude", affected: [], skipped: true };
    // Claude caches a copy on install and won't re-pull from a local marketplace,
    // so uninstall (keeping data) then re-install to force a fresh copy.
    for (const p of ctx.plugins) run(["plugin", "uninstall", p, "--scope", ctx.scope, "--keep-data"]);
    const act = claudeAgent.activate(ctx);
    return { agent: "claude", affected: act.affected, skipped: act.skipped };
  },
};
