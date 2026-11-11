import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { toPosix, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { globalPluginsDir, installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { isAdgOwnedName, makeCli, skippedResult, type RunResult } from "./base.ts";
import type { Agent, AgentContext, AgentInspectionResult, AgentPluginRecord, AgentListFailure, AgentListResult, AgentPruneResult, AgentScope, AgentSyncResult, StaleRegistration } from "./types.ts";

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
): RunResult {
  const listed = runner(["plugin", "marketplace", "list", "--json"]);
  if (listed.ok && parseClaudeMarketplaceList(listed.out).includes(name)) {
    // Claude's marketplace update path can fail on existing installs (for
    // example, merge-conflict-style failures on older CLI builds). When that
    // happens, fall back to re-adding the marketplace so the refresh remains
    // best-effort instead of surfacing a hard EXIT_CODE_1 in the ADG timeline.
    const updated = runner(["plugin", "marketplace", "update", name]);
    if (updated.ok) return updated;
  }
  const added = runner(["plugin", "marketplace", "add", pluginsDir]);
  if (!added.ok) {
    warn(`failed to sync Claude marketplace (${name}): ${added.out.trim() || "claude plugin marketplace add failed without an error message"}`);
  }
  return added;
}

/**
 * Parse `claude plugin marketplace list --json` into every directory-backed
 * marketplace with a resolvable path — the shape `pruneStale` needs to decide
 * which registrations are stale. `parseClaudeMarketplaceList` (above) only
 * extracts `name` because that's all drift-listing needs; this extracts `path`
 * too, since a URL/GitHub-sourced marketplace has none and can never go stale
 * this way (its source isn't a local directory that can vanish).
 */
export function parseClaudeMarketplaceDirectories(out: string): { name: string; path: string }[] {
  try {
    const parsed = JSON.parse(out) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: { name: string; path: string }[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, source, path } = entry as Record<string, unknown>;
      if (typeof name === "string" && source === "directory" && typeof path === "string") entries.push({ name, path });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Remove every ADG-owned Claude marketplace whose source directory no longer
 * exists — e.g. a deleted project, or a test sandbox that leaked into the real
 * `~/.claude` config (see `adg plugins prune`). Never touches a marketplace ADG
 * didn't create (`isAdgOwnedName`), and never one whose directory is still there.
 */
export function pruneStaleClaudeMarketplaces(
  runner: (args: string[]) => RunResult = run,
  exists: (path: string) => boolean = existsSync,
): AgentPruneResult {
  const listed = runner(["plugin", "marketplace", "list", "--json"]);
  if (!listed.ok) {
    return { agent: "claude", skipped: false, removed: [], errors: [listed.out.trim() || "claude plugin marketplace list failed without an error message"] };
  }
  const removed: StaleRegistration[] = [];
  const errors: string[] = [];
  for (const { name, path } of parseClaudeMarketplaceDirectories(listed.out)) {
    if (!isAdgOwnedName(name) || exists(path)) continue;
    const result = runner(["plugin", "marketplace", "remove", name]);
    if (result.ok) removed.push({ name, path });
    else errors.push(`failed to remove stale Claude marketplace "${name}": ${result.out.trim() || "no error message"}`);
  }
  return { agent: "claude", skipped: false, removed, errors };
}

/** Run every requested plugin independently and return actionable native failures. */
export function runClaudeLifecycle(
  ctx: AgentContext,
  operation: "activate" | "refresh" | "deactivate",
  runner: (args: string[]) => RunResult = run,
  isAvailable: () => boolean = available,
): AgentSyncResult {
  if (!isAvailable()) return skippedResult("claude");
  const result: AgentSyncResult = { agent: "claude", affected: [], skipped: false, failures: [] };
  const marketplace = claudeMarketplaceName(ctx.pluginsDir);
  if (operation !== "deactivate") {
    writeClaudeCatalog(ctx.pluginsDir);
    const synced = syncMarketplace(ctx.pluginsDir, marketplace, runner);
    if (!synced.ok) {
      result.failures!.push({ stage: "marketplace", errorType: "native_failure", message: synced.out.trim() || "Claude marketplace synchronization failed" });
      return result;
    }
  }
  let inspection: AgentPluginRecord[] | undefined;
  if (operation === "refresh") {
    const listed = runner(["plugin", "list", "--json"]);
    inspection = listed.ok ? parseClaudePluginRecords(listed.stdout ?? listed.out, marketplace, ctx.scope) : undefined;
    if (!inspection) {
      result.failures!.push({ stage: "inspect", errorType: "native_failure", message: listed.out.trim() || "Claude state could not be inspected before refresh" });
      return result;
    }
  }
  for (const plugin of ctx.plugins) {
    const native = inspection?.find((p) => p.name === plugin);
    if (operation === "refresh" && native && !native.enabled && !ctx.forceEnable) {
      (result.preservedDisabled ??= []).push(plugin);
      continue;
    }
    if (operation === "deactivate" || (operation === "refresh" && native)) {
      const removed = runner(["plugin", "uninstall", `${plugin}@${marketplace}`, "--scope", ctx.scope, ...(operation === "refresh" || ctx.preserveData ? ["--keep-data"] : [])]);
      const listed = !removed.ok ? runner(["plugin", "list", "--json"]) : undefined;
      const observed = listed?.ok ? parseClaudePluginRecords(listed.stdout ?? listed.out, marketplace, ctx.scope) : undefined;
      if (!removed.ok && !(observed && !observed.some((p) => p.name === plugin))) {
        result.failures!.push({ plugin, stage: "remove", errorType: "native_failure", message: removed.out.trim() || "Claude uninstall failed" });
        continue;
      }
    }
    if (operation !== "deactivate") {
      const installed = runner(["plugin", "install", `${plugin}@${marketplace}`, "--scope", ctx.scope]);
      if (!installed.ok) {
        result.failures!.push({ plugin, stage: "install", errorType: "native_failure", message: installed.out.trim() || "Claude install failed" });
        continue;
      }
      if (ctx.forceEnable) {
        const enabled = runner(["plugin", "enable", `${plugin}@${marketplace}`, "--scope", ctx.scope]);
        if (!enabled.ok) {
          result.failures!.push({ plugin, stage: "install", errorType: "native_failure", message: enabled.out.trim() || "Claude enable failed" });
          continue;
        }
      }
    }
    result.affected.push(plugin);
  }
  if (!result.failures!.length) delete result.failures;
  return result;
}

export const claudeAgent: Agent = {
  retrySafeOperations: ["refresh", "deactivate"],
  id: "claude",
  displayName: "Claude Code",
  adaptTarget: "claude",
  detect: (env = process.env) => existsSync(claudeHome(env)),
  available,

  activate: (ctx) => runClaudeLifecycle(ctx, "activate"),
  deactivate: (ctx) => runClaudeLifecycle(ctx, "deactivate"),
  refresh: (ctx) => runClaudeLifecycle(ctx, "refresh"),

  inspectPlugins(ctx: AgentContext): AgentInspectionResult {
    if (!available()) return undefined;
    const result = run(["plugin", "list", "--json"]);
    if (!result.ok) return { error: result.out.trim() || "Claude plugin inspection failed" };
    const records = parseClaudePluginRecords(result.stdout ?? result.out, claudeMarketplaceName(ctx.pluginsDir), ctx.scope);
    return records ?? { error: UNRECOGNIZED_PLUGIN_LIST };
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

  pruneStale: () => (available() ? pruneStaleClaudeMarketplaces() : { agent: "claude", skipped: true, removed: [], errors: [] }),
};

export function claudeListFailure(out: string): AgentListFailure {
  const detail = out.trim() || "claude plugin list failed without an error message";
  return { error: `${UNRECOGNIZED_PLUGIN_LIST}: ${detail}` };
}

/** Preserve disabled registrations and versions for transaction verification. */
export function parseClaudePluginRecords(out: string, marketplace: string, scope: AgentScope): AgentPluginRecord[] | undefined {
  try {
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return undefined;
    const records: AgentPluginRecord[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.scope !== "string" || typeof record.enabled !== "boolean") return undefined;
      const identity = record.id.match(/^(\S+?)@([\w.-]+)$/);
      if (!identity || identity[2] !== marketplace || record.scope.toLowerCase() !== scope) continue;
      records.push({ id: record.id, name: identity[1]!, installed: true, enabled: record.enabled,
        ...(typeof record.version === "string" ? { version: record.version } : {}) });
    }
    return records;
  } catch { return undefined; }
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
