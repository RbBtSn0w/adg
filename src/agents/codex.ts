import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexMarketplaceRoot, globalPluginsDir, marketplacePath } from "../paths.ts";
import { readMarketplace, writeMarketplace } from "../marketplace.ts";
import { makeCli, skippedResult } from "./base.ts";
import type { Agent, AgentContext, AgentListFailure, AgentListResult, AgentSyncResult } from "./types.ts";

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
 * Codex's default global marketplace is historically named `plugins`. Project
 * and explicit stores get a store-scoped name to avoid colliding with a global
 * or another project's configured marketplace.
 */
export function codexMarketplaceName(pluginsDir: string): string {
  const normalized = resolve(pluginsDir);
  if (normalized === resolve(globalPluginsDir())) return "plugins";
  const hash = createHash("sha1").update(normalized.split("\\").join("/")).digest("hex").slice(0, 8);
  return `adg-${hash}`;
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
function syncMarketplace(pluginsDir: string, marketplace: string): void {
  const root = codexMarketplaceRoot(pluginsDir);
  const add = run(["plugin", "marketplace", "add", root]);
  if (!add.ok) run(["plugin", "marketplace", "upgrade", marketplace]);
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
    syncMarketplace(ctx.pluginsDir, mp);
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "add", `${p}@${mp}`]).ok) affected.push(p);
    }
    return { agent: "codex", affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    const mp = writeCodexMarketplaceName(ctx.pluginsDir);
    if (!available()) return skippedResult("codex");
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
  listInstalled(ctx: AgentContext): AgentListResult {
    if (!available()) return undefined;
    const mp = writeCodexMarketplaceName(ctx.pluginsDir);
    if (!mp) return undefined; // no generated marketplace → can't scope the query
    const res = run(["plugin", "list"]);
    if (!res.ok) return codexListFailure(res.out);
    return parseCodexPluginList(res.out, mp);
  },
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
