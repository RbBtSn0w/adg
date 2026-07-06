import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { toPosix, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { globalPluginsDir, installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { makeCli, skippedResult, type RunResult } from "./base.ts";
import type { Agent, AgentContext, AgentListFailure, AgentListResult, AgentScope, AgentSyncResult } from "./types.ts";

/**
 * Claude Code agent.
 *
 * Claude consumes plugins through its own marketplace system, so we emit a
 * Claude-shaped catalog at `<pluginsDir>/.claude-plugin/marketplace.json` and
 * drive everything through the `claude plugin` CLI (which owns ~/.claude across
 * versions) rather than hand-editing Claude's internal state.
 */

const MARKETPLACE = "adg";
const UNRECOGNIZED_PLUGIN_LIST = "claude plugin list returned unrecognized output";

function claudeHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

const { available, run } = makeCli("claude", { probeArgs: ["plugin", "--help"] });

/**
 * Claude's marketplace registry is keyed only by marketplace name. Keep the
 * historical global marketplace name stable, but give project/explicit stores a
 * store-scoped name so a project install never updates or queries a stale global
 * `adg` marketplace.
 */
export function claudeMarketplaceName(pluginsDir: string): string {
  const normalized = resolve(pluginsDir);
  if (normalized === resolve(globalPluginsDir())) return MARKETPLACE;
  const hash = createHash("sha1").update(toPosix(normalized)).digest("hex").slice(0, 8);
  return `${MARKETPLACE}-${hash}`;
}

/**
 * Write a Claude marketplace catalog listing every installed plugin, each
 * `source` pointing at its on-disk directory (relative to the catalog).
 */
export function writeClaudeCatalog(pluginsDir: string, name: string = claudeMarketplaceName(pluginsDir)): { file: string; name: string } {
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

/** Parse `claude plugin marketplace list --json` into configured marketplace names. */
export function parseClaudeMarketplaceList(out: string): string[] {
  try {
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return undefined;
        const name = (entry as Record<string, unknown>)["name"];
        return typeof name === "string" ? name : undefined;
      })
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}

/** Register or refresh the ADG store as a Claude marketplace, failing open. */
export function syncMarketplace(
  pluginsDir: string,
  name: string,
  runner: (args: string[]) => RunResult = run,
  warn: (message: string) => void = console.warn,
): void {
  const listed = runner(["plugin", "marketplace", "list", "--json"]);
  if (listed.ok && parseClaudeMarketplaceList(listed.out).includes(name)) {
    // Claude's marketplace update path can fail on existing installs (for
    // example, merge-conflict-style failures on older CLI builds). When that
    // happens, fall back to re-adding the marketplace so the refresh remains
    // best-effort instead of surfacing a hard EXIT_CODE_1 in the ADG timeline.
    if (runner(["plugin", "marketplace", "update", name]).ok) return;
  }
  const added = runner(["plugin", "marketplace", "add", pluginsDir]);
  if (!added.ok) {
    warn(`${UNRECOGNIZED_PLUGIN_LIST.replace("plugin list returned unrecognized output", "failed to sync Claude marketplace")} (${name}): ${added.out.trim() || "claude plugin marketplace add failed without an error message"}`);
  }
}

export const claudeAgent: Agent = {
  id: "claude",
  displayName: "Claude Code",
  adaptTarget: "claude",
  detect: (env = process.env) => existsSync(claudeHome(env)),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return skippedResult("claude");
    const { name: marketplace } = writeClaudeCatalog(ctx.pluginsDir);
    syncMarketplace(ctx.pluginsDir, marketplace);
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      const r = run(["plugin", "install", `${p}@${marketplace}`, "--scope", ctx.scope]);
      if (r.ok) affected.push(p);
      // Surface the CLI's reason instead of silently dropping the plugin — a
      // rejected manifest (e.g. `hooks: Invalid input`) otherwise looks like a
      // no-op "missing" with no diagnostic.
      else console.error(`claude: failed to install ${p}@${marketplace}: ${r.out.trim()}`);
    }
    return { agent: "claude", affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return skippedResult("claude");
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "uninstall", p, "--scope", ctx.scope]).ok) affected.push(p);
    }
    return { agent: "claude", affected, skipped: false };
  },

  refresh(ctx: AgentContext): AgentSyncResult {
    if (!available()) return skippedResult("claude");
    // Claude caches a copy on install and won't re-pull from a local marketplace,
    // so uninstall (keeping data) then re-install to force a fresh copy.
    for (const p of ctx.plugins) run(["plugin", "uninstall", p, "--scope", ctx.scope, "--keep-data"]);
    const act = claudeAgent.activate(ctx);
    return { agent: "claude", affected: act.affected, skipped: act.skipped };
  },

  // Query Claude's live plugin state for `adg plugins status`, scoped to the
  // ADG marketplace and the requested install scope. `available()` gates the
  // query so an absent CLI is a quiet `undefined` ("unknown").
  listInstalled(ctx: AgentContext): AgentListResult {
    if (!available()) return undefined;
    const marketplace = claudeMarketplaceName(ctx.pluginsDir);
    const jsonRes = run(["plugin", "list", "--json"]);
    if (jsonRes.ok) {
      const parsed = parseClaudePluginListJson(jsonRes.out, marketplace, ctx.scope);
      if (parsed !== undefined) return parsed;
      return claudeListFailure(jsonRes.out);
    }
    const textRes = run(["plugin", "list"]);
    if (!textRes.ok) return { error: textRes.out.trim() || jsonRes.out.trim() || "claude plugin list failed without an error message" };
    const fallback = parseClaudePluginList(textRes.out, marketplace, ctx.scope);
    if (fallback.length > 0 || textRes.out.trim() === "") return fallback;
    return claudeListFailure(textRes.out);
  },
};

export function claudeListFailure(out: string): AgentListFailure {
  const detail = out.trim() || "claude plugin list failed without an error message";
  return { error: `${UNRECOGNIZED_PLUGIN_LIST}: ${detail}` };
}

/** Parse `claude plugin list --json` into enabled plugin names for a marketplace + scope. */
export function parseClaudePluginListJson(out: string, marketplace: string, scope: AgentScope): string[] | undefined {
  try {
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      const entryScope = typeof record.scope === "string" ? record.scope.toLowerCase() : undefined;
      const enabled = record.enabled === true;
      const head = id?.match(/^(\S+?)@([\w.-]+)$/);
      if (!head || head[2] !== marketplace || entryScope !== scope || !enabled || seen.has(head[1]!)) continue;
      seen.add(head[1]!);
      names.push(head[1]!);
    }
    return names;
  } catch {
    return undefined;
  }
}

/**
 * Parse `claude plugin list` output into the *enabled* plugin names from a given
 * marketplace and install scope. The listing groups each plugin as a
 * `❯ <name>@<marketplace>` header followed by indented `Scope:` / `Status:`
 * lines; we pair them so a plugin enabled only in another scope, disabled, or
 * from a different marketplace is excluded. Pure (no CLI) so it is unit-testable
 * against captured output.
 */
export function parseClaudePluginList(out: string, marketplace: string, scope: AgentScope): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur: { name: string; mp: string; scope?: string; enabled?: boolean } | undefined;
  const flush = (): void => {
    if (cur && cur.mp === marketplace && cur.scope === scope && cur.enabled && !seen.has(cur.name)) {
      seen.add(cur.name);
      names.push(cur.name);
    }
  };
  for (const line of out.split("\n")) {
    const head = line.match(/^\s*❯\s*(\S+?)@([\w.-]+)\s*$/);
    if (head) {
      flush();
      cur = { name: head[1]!, mp: head[2]! };
      continue;
    }
    if (!cur) continue;
    const sc = line.match(/^\s*Scope:\s*(\S+)/);
    if (sc) {
      // Normalize case so a future `Scope: Project` still matches "project".
      cur.scope = sc[1]!.toLowerCase();
      continue;
    }
    const st = line.match(/^\s*Status:\s*(.+)$/);
    // "disabled" does not contain "enabled", so a substring test cleanly
    // distinguishes the two states.
    if (st) cur.enabled = /enabled/i.test(st[1]!);
  }
  flush();
  return names;
}
