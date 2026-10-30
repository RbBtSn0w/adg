import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SpanKind } from "@opentelemetry/api";
import { codexMarketplaceRoot, globalPluginsDir, marketplacePath } from "../paths.ts";
import { readMarketplace, writeMarketplace } from "../marketplace.ts";
import { isAdgOwnedName, isAdgSandboxCacheDirName, makeCli, skippedResult } from "./base.ts";
import { reconcileCodexMarketplaceAliases } from "../codex-marketplace-migration.ts";
import { getTracer, recordTelemetryEvent } from "../telemetry.ts";
import type { Agent, AgentContext, AgentListFailure, AgentListResult, AgentPruneResult, AgentSyncResult, StaleRegistration } from "./types.ts";

const UNRECOGNIZED_PLUGIN_LIST = "codex plugin list returned unrecognized output";
const MARKETPLACE = "adg";

/**
 * Codex agent.
 *
 * Codex consumes configured marketplace roots. For a project store at
 * `<root>/.agents/plugins`, the configured root is `<root>`; the marketplace file
 * remains at `.agents/plugins/marketplace.json`. Plugins are usable only after
 * `codex plugin add`, so activation registers the root then installs the plugin.
 */

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

const { available, run } = makeCli("codex", { probeArgs: ["plugin", "--help"] });

/**
 * Keep Codex's global marketplace identity aligned with the Claude projection.
 * Project and explicit stores get a store-scoped name to avoid colliding with
 * the global store or another project's configured marketplace.
 */
export function codexMarketplaceName(pluginsDir: string): string {
  const normalized = resolve(pluginsDir);
  if (normalized === resolve(globalPluginsDir())) return MARKETPLACE;
  const hash = createHash("sha1").update(normalized.split("\\").join("/")).digest("hex").slice(0, 8);
  return `${MARKETPLACE}-${hash}`;
}

/** Ensure the generated Codex marketplace export uses this store's scoped name. */
export function writeCodexMarketplaceName(pluginsDir: string): string {
  const file = marketplacePath(pluginsDir);
  const marketplace = readMarketplace(file, codexMarketplaceName(pluginsDir));
  const name = codexMarketplaceName(pluginsDir);
  if (marketplace.name !== name) {
    marketplace.name = name;
    writeMarketplace(file, marketplace);
  }
  return name;
}

/** Register the local marketplace root Codex expects for this store. */
export function syncMarketplace(
  pluginsDir: string,
  marketplace: string,
  runner: typeof run = run,
  warn: (message: string) => void = console.warn,
): boolean {
  const root = codexMarketplaceRoot(pluginsDir);
  // Explicit stores need the same supported discovery layout as canonical stores.
  if (root === pluginsDir && existsSync(marketplacePath(pluginsDir))) {
    try {
      const exportDir = join(root, ".agents", "plugins");
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(join(exportDir, "marketplace.json"), readFileSync(marketplacePath(pluginsDir)));
    } catch (error) {
      warn(`failed to sync Codex marketplace (${marketplace}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  const add = runner(["plugin", "marketplace", "add", root]);
  if (add.ok) return true;
  const upgraded = runner(["plugin", "marketplace", "upgrade", marketplace]);
  if (!upgraded.ok) {
    warn(`failed to sync Codex marketplace (${marketplace}): ${upgraded.out.trim() || add.out.trim() || "codex plugin marketplace sync failed without an error message"}`);
  }
  return upgraded.ok;
}

/**
 * Best-effort retirement of historical aliases after canonical installs succeed.
 * Keep this compatibility path only until telemetry reports no legacy aliases for
 * two release cycles.
 */
function reconcileLegacyAliases(pluginsDir: string, marketplace: string, plugins: string[]): void {
  getTracer().startActiveSpan("adg.codex.marketplace_alias_migration", { kind: SpanKind.INTERNAL }, (span) => {
    try {
      const result = reconcileCodexMarketplaceAliases({
        pluginsDir,
        marketplace,
        plugins,
        readConfig: () => readFileSync(join(codexHome(process.env), "config.toml"), "utf8"),
        run,
        report: (attributes) => recordTelemetryEvent("adg.codex.marketplace_alias_migration", attributes, span),
      });
      if (result.outcome === "partial") {
        console.warn("Codex legacy marketplace alias cleanup was only partially completed; rerun `adg plugins sync --target codex` to retry.");
      }
    } finally {
      span.end();
    }
  });
}

/**
 * Parse `codex plugin marketplace list --json` into every locally-sourced
 * marketplace with its root directory — the shape `pruneStale` needs to decide
 * which registrations are stale. A Git-sourced marketplace has no local root
 * that can vanish this way, so only `sourceType: "local"` entries qualify.
 */
export function parseCodexMarketplaceLocalSources(out: string): { name: string; path: string }[] {
  try {
    const parsed = JSON.parse(out) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const marketplaces = (parsed as Record<string, unknown>).marketplaces;
    if (!Array.isArray(marketplaces)) return [];
    const entries: { name: string; path: string }[] = [];
    for (const entry of marketplaces) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, marketplaceSource } = entry as Record<string, unknown>;
      if (typeof name !== "string" || typeof marketplaceSource !== "object" || marketplaceSource === null) continue;
      const { sourceType, source } = marketplaceSource as Record<string, unknown>;
      if (sourceType === "local" && typeof source === "string") entries.push({ name, path: source });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Directory names under `<CODEX_HOME>/plugins/cache` (best-effort; a missing/unreadable root is just empty). */
function codexCacheDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Parse every stale-marketplace bullet out of a `codex plugin marketplace
 * list` failure: `- \`name\` at path: marketplace root does not contain a
 * supported manifest`. Codex fails the WHOLE `list` call (JSON or not) the
 * moment ANY registered marketplace's root lacks a manifest — verified live
 * against codex-cli 0.154.0 — bulleting every offender it found in one
 * message, so this recovers all of them in a single pass rather than just one.
 */
export function parseCodexStaleMarketplaceErrors(out: string): { name: string; path: string }[] {
  const entries: { name: string; path: string }[] = [];
  for (const m of out.matchAll(/- `([^`]+)` at (.+?): marketplace root does not contain a supported manifest/g)) {
    entries.push({ name: m[1]!, path: m[2]! });
  }
  return entries;
}

/**
 * Whether a Codex marketplace's registered root (`source`) still resolves to
 * a live ADG marketplace manifest. Checking `existsSync(source)` alone isn't
 * enough: for a canonical `<root>/.agents/plugins` store, Codex is registered
 * against `<root>` (see `codexMarketplaceRoot`), not the plugins directory
 * itself — so after a project's `.agents/` is deleted but its root survives,
 * `source` still exists even though the marketplace is exactly what Codex
 * calls stale. An explicit `--dir` store has no such project root: `source`
 * IS the plugins directory, with `marketplace.json` directly under it.
 */
function codexMarketplaceIsLive(source: string, exists: (path: string) => boolean): boolean {
  return exists(join(source, ".agents", "plugins", "marketplace.json")) || exists(join(source, "marketplace.json"));
}

/**
 * List Codex's registered marketplaces, recovering from the failure mode
 * `parseCodexStaleMarketplaceErrors` targets: one broken ADG-owned
 * registration otherwise fails the whole `list` call and blocks pruning every
 * other, unrelated, genuinely-stale entry. Removes every ADG-owned offender
 * the error names and retries once; a non-ADG-owned offender (not ours to
 * touch) or a `remove` that itself fails is left in `errors` for the caller.
 */
function listCodexMarketplaces(
  runner: typeof run,
): { ok: true; sources: { name: string; path: string }[]; removed: StaleRegistration[]; errors: string[] }
  | { ok: false; error: string; removed: StaleRegistration[]; errors: string[] } {
  const removed: StaleRegistration[] = [];
  const errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = runner(["plugin", "marketplace", "list", "--json"]);
    if (listed.ok) return { ok: true, sources: parseCodexMarketplaceLocalSources(listed.stdout ?? listed.out), removed, errors };

    const detail = listed.out.trim() || "codex plugin marketplace list failed without an error message";
    const ownedStale = parseCodexStaleMarketplaceErrors(listed.out).filter((e) => isAdgOwnedName(e.name));
    if (attempt === 1 || ownedStale.length === 0) return { ok: false, error: detail, removed, errors };

    for (const { name, path } of ownedStale) {
      const result = runner(["plugin", "marketplace", "remove", name]);
      if (result.ok) removed.push({ name, path });
      else errors.push(`failed to remove stale Codex marketplace "${name}": ${result.out.trim() || "no error message"}`);
    }
  }
  /* c8 ignore next */
  return { ok: false, error: "codex plugin marketplace list failed without an error message", removed, errors };
}

/**
 * Remove every ADG-owned Codex marketplace whose plugins directory no longer
 * exists — e.g. a deleted project, or a test sandbox that leaked into the real
 * `~/.codex` config (see `adg plugins prune`) — then sweep
 * `plugins/cache/adg-<hash>` directories that outlived their registry entry
 * (observed in practice: `codex plugin marketplace remove` doesn't reliably
 * clear the cache snapshot it staged). Never touches a marketplace ADG didn't
 * create (`isAdgOwnedName`), never one whose directory is still there, and the
 * cache sweep never touches the bare global `adg` cache dir (`isAdgSandboxCacheDirName`
 * requires the hash suffix) since that deletion has no CLI-level undo.
 */
export function pruneStaleCodexMarketplaces(
  runner: typeof run = run,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  listCacheDirNames: (dir: string) => string[] = codexCacheDirNames,
  removeCacheDir: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): AgentPruneResult {
  const listing = listCodexMarketplaces(runner);
  const removed: StaleRegistration[] = [...listing.removed];
  const errors: string[] = [...listing.errors];

  if (!listing.ok) {
    errors.push(listing.error);
    return { agent: "codex", skipped: false, removed, errors };
  }

  const survivingNames = new Set(listing.sources.map((s) => s.name));
  for (const { name, path } of listing.sources) {
    if (!isAdgOwnedName(name) || codexMarketplaceIsLive(path, exists)) continue;
    const result = runner(["plugin", "marketplace", "remove", name]);
    if (result.ok) {
      removed.push({ name, path });
      survivingNames.delete(name);
    } else {
      errors.push(`failed to remove stale Codex marketplace "${name}": ${result.out.trim() || "no error message"}`);
    }
  }

  const cacheRoot = join(codexHome(env), "plugins", "cache");
  for (const dirName of listCacheDirNames(cacheRoot)) {
    if (!isAdgSandboxCacheDirName(dirName) || survivingNames.has(dirName)) continue;
    const path = join(cacheRoot, dirName);
    try {
      removeCacheDir(path);
      removed.push({ name: dirName, path });
    } catch (err) {
      errors.push(`failed to remove orphaned Codex cache dir "${dirName}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { agent: "codex", skipped: false, removed, errors };
}

export const codexAgent: Agent = {
  id: "codex",
  displayName: "Codex",
  adaptTarget: "codex",
  detect: (env = process.env) => existsSync(codexHome(env)) || existsSync("/etc/codex"),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    const mp = writeCodexMarketplaceName(ctx.pluginsDir);
    if (!available()) return skippedResult("codex");
    let diagnostic = "";
    if (!syncMarketplace(ctx.pluginsDir, mp, run, (message) => { diagnostic = message; })) return { agent: "codex", affected: [], skipped: false, failures: [{ stage: "marketplace", errorType: "MARKETPLACE_SYNC_FAILED", message: diagnostic || "Codex marketplace registration failed; plugin installation was not attempted." }] };
    const affected: string[] = [];
    const failures: NonNullable<AgentSyncResult["failures"]> = [];
    for (const p of ctx.plugins) {
      const result = run(["plugin", "add", `${p}@${mp}`]);
      if (result.ok) affected.push(p);
      else failures.push({ plugin: p, stage: "install", errorType: "CLI_FAILURE", message: result.out.trim() || "Codex installation failed." });
    }
    if (ctx.reconcileLegacyAliases && affected.length > 0) reconcileLegacyAliases(ctx.pluginsDir, mp, affected);
    return { agent: "codex", affected, skipped: false, ...(failures.length ? { failures } : {}) };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    const mp = writeCodexMarketplaceName(ctx.pluginsDir);
    if (!available()) return skippedResult("codex");
    const affected: string[] = [];
    const failures: NonNullable<AgentSyncResult["failures"]> = [];
    for (const p of ctx.plugins) {
      const result = run(["plugin", "remove", `${p}@${mp}`]);
      if (result.ok) affected.push(p);
      else failures.push({ plugin: p, stage: "remove", errorType: "CLI_FAILURE", message: result.out.trim() || "Codex removal failed." });
    }
    return { agent: "codex", affected, skipped: false, ...(failures.length ? { failures } : {}) };
  },

  // `codex plugin add` stages into `.remote-plugin-install-staging` and swaps the
  // cache entry (keeping a `.tmp/plugins-backup-*`), so it *replaces* rather than
  // merges — re-adding is a clean, atomic refresh with no stale-component residue.
  // (Contrast agy, whose `install` merges and so needs an explicit uninstall.)
  refresh(ctx: AgentContext): AgentSyncResult {
    return codexAgent.activate(ctx);
  },

  inspectPlugins(ctx) {
    if (!available()) return undefined;
    const marketplace = codexMarketplaceName(ctx.pluginsDir);
    return getTracer().startActiveSpan("adg.codex.inspect_plugins", (span) => {
      try {
        const result = run(["plugin", "list", "--available", "--marketplace", marketplace, "--json"]);
        if (!result.ok) return codexListFailure(result.out);
        const records = parseCodexInspection(result.stdout ?? result.out, marketplace);
        recordTelemetryEvent("adg.codex.inspect_plugins", {
          "inspection.valid": records !== undefined,
          "inspection.record_count": records?.length ?? 0,
          "inspection.version_count": records?.filter((record) => record.version !== undefined).length ?? 0,
          "inspection.stderr_present": Boolean(result.stderr),
        }, span);
        return records ?? codexUnrecognizedListFailure(result.out);
      } finally { span.end(); }
    });
  },

  // Query Codex's live plugin state for `adg plugins status`, scoped to our
  // generated marketplace. `available()` gates the query so an absent CLI is a
  // quiet `undefined` ("unknown").
  listInstalled(ctx: AgentContext): AgentListResult {
    if (!available()) return undefined;
    const mp = codexMarketplaceName(ctx.pluginsDir);
    if (!mp) return undefined; // no generated marketplace → can't scope the query
    const jsonRes = run(["plugin", "list", "--json"]);
    if (jsonRes.ok) {
      const parsed = parseCodexPluginListJson(jsonRes.stdout ?? jsonRes.out, mp);
      if (parsed !== undefined) return parsed;
      return codexUnrecognizedListFailure(jsonRes.out);
    }
    const textRes = run(["plugin", "list"]);
    if (!textRes.ok) return codexListFailure(textRes.out || jsonRes.out);
    const fallback = parseCodexPluginList(textRes.out, mp);
    if (fallback.length > 0 || textRes.out.trim() === "") return fallback;
    return codexUnrecognizedListFailure(textRes.out);
  },

  pruneStale: () => (available() ? pruneStaleCodexMarketplaces() : { agent: "codex", skipped: true, removed: [], errors: [] }),
};

/** Preserve Codex's diagnostic and offer cleanup for a stale ADG project marketplace. */
export function codexListFailure(out: string): AgentListFailure {
  const detail = out.trim() || "codex plugin list failed without an error message";
  const staleMarketplace = detail.match(/- `(adg-[0-9a-f]{8})` at .*marketplace root does not contain a supported manifest/);
  return {
    error: detail,
    ...(staleMarketplace ? { recoveryCommand: `codex plugin marketplace remove ${staleMarketplace[1]}` } : {}),
  };
}

export function codexUnrecognizedListFailure(out: string): AgentListFailure {
  const detail = out.trim() || "codex plugin list failed without an error message";
  return { error: `${UNRECOGNIZED_PLUGIN_LIST}: ${detail}` };
}

/** Parse `codex plugin list --json` into installed and enabled plugin names for one marketplace. */
export function parseCodexPluginListJson(out: string, marketplace: string): string[] | undefined {
  return parseCodexInspection(out, marketplace)?.filter((record) => record.installed && record.enabled).map((record) => record.name);
}

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
    if (!status.includes("installed") || !status.includes("enabled") || status.includes("disabled")) continue;
    if (!seen.has(head[1]!)) {
      seen.add(head[1]!);
      names.push(head[1]!);
    }
  }
  return names;
}

/** Reject malformed snapshots instead of interpreting them as missing registrations. */
export function parseCodexInspection(out: string, marketplace: string): import("./types.ts").AgentPluginRecord[] | undefined {
  try {
    const parsed = JSON.parse(out);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.installed)) return undefined;
    const available = parsed.available === undefined ? [] : parsed.available;
    if (!Array.isArray(available)) return undefined;
    const records = new Map<string, import("./types.ts").AgentPluginRecord>();
    for (const record of [...parsed.installed, ...available]) {
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.marketplaceName !== "string") return undefined;
      if (record.marketplaceName !== marketplace) continue;
      if (typeof record.name !== "string" || !record.name.trim() || record.pluginId !== `${record.name}@${marketplace}` || typeof record.installed !== "boolean" || typeof record.enabled !== "boolean" || (record.enabled && !record.installed)) return undefined;
      if (record.version != null && (typeof record.version !== "string" || !record.version.trim())) return undefined;
      if (records.has(record.name)) return undefined;
      records.set(record.name, { id: record.pluginId, name: record.name, installed: record.installed, enabled: record.enabled,
        ...(typeof record.version === "string" ? { version: record.version } : {}) });
    }
    return [...records.values()];
  } catch { return undefined; }
}
