import { cpSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ensureDir, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { resolveSkillEntries } from "../skills.ts";
import { isExposed } from "../components.ts";
import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { ANTIGRAVITY_PROJECTION_DIR } from "../adapters/antigravity.ts";
import { mcpConfigPath } from "../mcp.ts";
import { makeCli, skippedResult } from "./base.ts";
import type { AdgManifest, ComponentType, PluginSelection } from "../types.ts";
import type { Agent, AgentContext, AgentSyncResult } from "./types.ts";

/**
 * Antigravity (`agy`) agent.
 *
 * Antigravity discovers a plugin by convention relative to the directory handed
 * to `agy plugin install` — `plugin.json` plus sibling `skills/`, `agents/`,
 * `commands/`, `hooks/` dirs plus plugin.json path pointers. We therefore
 * project a self-contained agy plugin root under `<store>/.antigravity-plugin/`:
 * generated `plugin.json` + copied MCP config (when selected) and
 * *symlinks* to the real component dirs one level up, so nothing is duplicated
 * on disk. agy follows these symlinks; where the platform forbids them (e.g.
 * Windows without privilege) we fall back to a copy. We then drive
 * `agy plugin install/uninstall` (which owns `~/.gemini/antigravity-cli`).
 */

const ID = "antigravity";

/**
 * Single-directory component fields: agy reads each as a sibling dir named by
 * convention. `skills` is handled separately because it can be a path-list and
 * supports per-skill subsetting.
 */
const DIR_FIELDS = ["agents", "commands", "hooks"] as const satisfies readonly ComponentType[];

function geminiHome(env: NodeJS.ProcessEnv): string {
  return env.GEMINI_HOME?.trim() || join(homedir(), ".gemini");
}

/**
 * agy's config/store home: `<GEMINI_HOME>/antigravity-cli` (defaulting to
 * `~/.gemini/antigravity-cli`). Exported so the resolver itself is testable
 * without depending on the host filesystem state.
 */
export function antigravityHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiHome(env), "antigravity-cli");
}

// `--help` is rejected by `agy plugin install` (it parses it as a target), so
// probe the plugin command group with its own `help` subcommand instead.
// `echoStderr` surfaces the CLI's own diagnostics on failure.
const { available, run } = makeCli("agy", { probeArgs: ["plugin", "help"], echoStderr: true });

/** A plugin's resolved store directory plus its persisted partial-install selection. */
interface PluginStore {
  dir: string;
  selection?: PluginSelection;
}

/** Resolve a plugin's on-disk store directory and selection from the lock's provenance. */
function pluginStore(pluginsDir: string, name: string): PluginStore | undefined {
  const entry = readLock(lockPath(pluginsDir)).plugins[name];
  if (!entry) return undefined;
  const dir = installedPluginDir(pluginsDir, name, entry.origin);
  return existsSync(dir) ? { dir, selection: entry.selection } : undefined;
}

/** First on-disk top segment of a declared component path (e.g. "./agents/" -> "agents"). */
function componentSegment(value: AdgManifest[keyof AdgManifest]): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return undefined;
  const seg = first.replace(/^\.?[/\\]/, "").split(/[/\\]/)[0];
  return seg || undefined;
}

/**
 * Symlink `linkPath` at `absTarget` (target stored relative so the projection
 * survives the whole plugin dir being moved), copying instead where symlinks are
 * unavailable (e.g. Windows without privilege). Idempotent.
 */
function linkOrCopy(linkPath: string, absTarget: string): void {
  rmSync(linkPath, { recursive: true, force: true });
  ensureDir(dirname(linkPath));
  try {
    symlinkSync(relative(dirname(linkPath), absTarget), linkPath, "dir");
  } catch {
    cpSync(absTarget, linkPath, { recursive: true });
  }
}

/** Link a file with a relative symlink, copying instead when symlinks fail. */
function linkFileOrCopy(linkPath: string, absTarget: string): void {
  rmSync(linkPath, { force: true });
  ensureDir(dirname(linkPath));
  try {
    symlinkSync(relative(dirname(linkPath), absTarget), linkPath, "file");
  } catch {
    cpSync(absTarget, linkPath);
  }
}

/**
 * Build the agy-native projection under `<dir>/.antigravity-plugin/`: a
 * `plugin.json`, an MCP config file copied verbatim from the manifest's
 * `mcpServers` pointer when present, an agy-conventional `mcp_config.json` link
 * to that file, and relative symlinks (copy fallback) to the declared component
 * dirs named for agy's convention.
 *
 * An optional `selection` (the plugin's partial install) narrows what is
 * projected: component categories outside it are dropped, and `skills` is pinned
 * to the selected subset. `skills` is also projected per-skill into a real
 * `skills/` dir, so a path-list spanning multiple roots is fully honored rather
 * than collapsing to its first root. Idempotent; safe to re-run.
 */
export function writeAntigravityProjection(dir: string, selection?: PluginSelection): void {
  const manifest = readManifest(dir);
  const stage = join(dir, ANTIGRAVITY_PROJECTION_DIR);
  ensureDir(stage);
  rmSync(join(stage, "mcp_config.json"), { force: true });

  const mcp = mcpConfigPath(manifest);
  const pluginJson: Record<string, unknown> = { name: manifest.name };
  if (mcp && isExposed(selection, "mcp")) {
    pluginJson.mcpServers = mcp;
    const mcpFile = join(dir, mcp);
    const projectedMcp = join(stage, mcp);
    rmSync(projectedMcp, { force: true });
    ensureDir(dirname(projectedMcp));
    // Copy verbatim — preserving formatting and avoiding a parse/re-serialize round-trip.
    if (existsSync(mcpFile)) {
      cpSync(mcpFile, projectedMcp);
      linkFileOrCopy(join(stage, "mcp_config.json"), projectedMcp);
    }
  } else {
    rmSync(join(stage, mcp || ".mcp.json"), { force: true });
  }
  writeJson(join(stage, "plugin.json"), pluginJson);

  const skillsDir = join(stage, "skills");
  rmSync(skillsDir, { recursive: true, force: true });
  if (manifest.skills !== undefined && isExposed(selection, "skills")) {
    const pick = selection?.skills;
    for (const e of resolveSkillEntries(dir, manifest)) {
      if (pick && !pick.includes(e.name)) continue;
      if (!e.skillMd) continue;
      const srcSkillDir = dirname(e.skillMd);
      if (existsSync(srcSkillDir) && statSync(srcSkillDir).isDirectory()) {
        linkOrCopy(join(skillsDir, e.name), srcSkillDir);
      }
    }
  }

  for (const field of DIR_FIELDS) {
    const link = join(stage, field);
    rmSync(link, { recursive: true, force: true });
    if (!isExposed(selection, field)) continue;
    const seg = componentSegment(manifest[field]);
    if (!seg) continue;
    const srcDir = join(dir, seg);
    // agy reads the component by its convention name (`field`); point that at
    // the real source dir so a non-conventional source name still resolves.
    if (existsSync(srcDir)) linkOrCopy(link, srcDir);
  }
}

export const antigravityAgent: Agent = {
  id: ID,
  displayName: "Antigravity",
  adaptTarget: "antigravity",
  detect: (env = process.env) => existsSync(antigravityHome(env)),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    const cliAvailable = available();
    // Query agy once up front so the pre-install uninstall below is issued only
    // for plugins that are actually present (a brand-new plugin has no residual
    // to clear). `undefined` (couldn't enumerate) falls back to always
    // uninstalling, preserving the clean-replace guarantee.
    const installed = cliAvailable ? antigravityInstalled() : undefined;
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      // Isolate each plugin: a malformed manifest or a filesystem error must not
      // abort activation of the remaining (valid) plugins.
      try {
        const store = pluginStore(ctx.pluginsDir, p);
        if (!store) continue;
        writeAntigravityProjection(store.dir, store.selection);
        if (!cliAvailable) continue;
        // `agy plugin install` *merges* into an existing `<store>/plugins/<name>`
        // rather than replacing it, so components dropped since the last sync (a
        // narrowed selection, or a skill removed upstream) would linger as
        // residual data. Uninstall an existing copy first to force a clean
        // re-import; skip it for a not-yet-installed plugin (nothing to clear).
        if (installed === undefined || installed.includes(p)) {
          run(["plugin", "uninstall", p]);
        }
        if (run(["plugin", "install", join(store.dir, ANTIGRAVITY_PROJECTION_DIR)]).ok) affected.push(p);
      } catch (err) {
        console.error(`failed to enable "${p}" in Antigravity:`, err);
      }
    }
    if (!cliAvailable) return skippedResult(ID);
    return { agent: ID, affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return skippedResult(ID);
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "uninstall", p]).ok) affected.push(p);
    }
    return { agent: ID, affected, skipped: false };
  },

  // Re-running activate is the refresh: it uninstalls then re-imports the source
  // dir, so a shrunk component set replaces the stale copy instead of merging.
  refresh(ctx: AgentContext): AgentSyncResult {
    return antigravityAgent.activate(ctx);
  },

  // `agy plugin list` emits JSON (`{ imports: [{ name }] }`). agy has no
  // marketplace concept, so this returns *every* imported plugin — including
  // ones imported outside ADG; the caller treats agy-only names as "not managed
  // here" rather than asserting they are ADG orphans.
  // `available()` (stdio-ignored probe) gates the query, so an absent CLI is a
  // quiet `undefined` ("unknown") rather than echoing a spawn error to stderr.
  listInstalled: () => antigravityInstalled(),
};

/**
 * The plugin names agy currently has imported, or `undefined` when the CLI is
 * absent or its output can't be parsed. Shared by `listInstalled` and by
 * `activate` (to skip the pre-install uninstall for brand-new plugins).
 */
function antigravityInstalled(): string[] | undefined {
  if (!available()) return undefined;
  const res = run(["plugin", "list"]);
  if (!res.ok) return undefined;
  return parseAntigravityPluginList(res.out);
}

/**
 * Parse `agy plugin list` JSON (`{ imports: [{ name }] }`) into deduped plugin
 * names, or `undefined` when the output isn't the expected JSON. Pure (no CLI)
 * so it is unit-testable against captured output.
 */
export function parseAntigravityPluginList(out: string): string[] | undefined {
  try {
    const parsed = JSON.parse(out) as { imports?: { name?: unknown }[] };
    const names = (parsed.imports ?? [])
      .map((i) => i.name)
      .filter((n): n is string => typeof n === "string");
    return [...new Set(names)];
  } catch {
    return undefined; // unparseable output — report "unknown", don't guess
  }
}
