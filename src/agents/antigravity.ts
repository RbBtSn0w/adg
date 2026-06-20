import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { ANTIGRAVITY_PROJECTION_DIR } from "../adapters/antigravity.ts";
import type { AdgManifest } from "../types.ts";
import type { Agent, AgentContext, AgentSyncResult } from "./types.ts";

/**
 * Antigravity (`agy`) agent.
 *
 * Antigravity discovers a plugin by convention relative to the directory handed
 * to `agy plugin install` — `plugin.json` plus sibling `skills/`, `agents/`,
 * `commands/`, `hooks/` dirs and a `mcp_config.json`, with no manifest path
 * indirection. We therefore project a self-contained agy plugin root under
 * `<store>/.antigravity-plugin/`: generated `plugin.json` + `mcp_config.json`
 * (the ADG `mcp/.mcp.json` shape is exactly agy's, so it passes through) and
 * *symlinks* to the real component dirs one level up, so nothing is duplicated
 * on disk. agy follows these symlinks; where the platform forbids them (e.g.
 * Windows without privilege) we fall back to a copy. We then drive
 * `agy plugin install/uninstall` (which owns `~/.gemini/antigravity-cli`).
 */

const ID = "antigravity";

/** Manifest fields whose directory agy reads, mapped onto agy's convention name. */
const COMPONENT_FIELDS = ["skills", "agents", "commands", "hooks"] as const;

function geminiHome(env: NodeJS.ProcessEnv): string {
  return env.GEMINI_HOME?.trim() || join(homedir(), ".gemini");
}

function antigravityHome(env: NodeJS.ProcessEnv): string {
  return join(geminiHome(env), "antigravity-cli");
}

function available(): boolean {
  // `--help` is rejected by `install` (it parses it as a target), so probe the
  // plugin command group with its own `help` subcommand instead.
  return spawnSync("agy", ["plugin", "help"], { stdio: "ignore" }).status === 0;
}

function run(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("agy", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Resolve a plugin's on-disk store directory from the lock's provenance. */
function pluginStoreDir(pluginsDir: string, name: string): string | undefined {
  const entry = readLock(lockPath(pluginsDir)).plugins[name];
  if (!entry) return undefined;
  const dir = installedPluginDir(pluginsDir, name, entry.origin);
  return existsSync(dir) ? dir : undefined;
}

/** First on-disk top segment of a declared component path (e.g. "./skills/" -> "skills"). */
function componentSegment(value: AdgManifest[keyof AdgManifest]): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return undefined;
  const seg = first.replace(/^\.?[/\\]/, "").split(/[/\\]/)[0];
  return seg || undefined;
}

/** Symlink `linkPath` -> `relTarget`, copying `absTarget` instead where symlinks are unavailable. */
function linkOrCopy(relTarget: string, linkPath: string, absTarget: string): void {
  rmSync(linkPath, { recursive: true, force: true }); // idempotent re-projection
  try {
    symlinkSync(relTarget, linkPath, "dir");
  } catch {
    cpSync(absTarget, linkPath, { recursive: true });
  }
}

/**
 * Build the agy-native projection under `<dir>/.antigravity-plugin/`: a
 * `plugin.json` (name only), a `mcp_config.json` transcribed from the manifest's
 * mcp file when present, and a relative symlink (copy fallback) per declared
 * component dir, named for agy's convention. Idempotent; safe to re-run.
 */
export function writeAntigravityProjection(dir: string): void {
  const manifest = readManifest(dir);
  const stage = join(dir, ANTIGRAVITY_PROJECTION_DIR);
  ensureDir(stage);

  writeJson(join(stage, "plugin.json"), { name: manifest.name });

  const mcpConfig = join(stage, "mcp_config.json");
  rmSync(mcpConfig, { force: true });
  if (manifest.mcp) {
    const mcpFile = join(dir, manifest.mcp);
    if (existsSync(mcpFile)) writeJson(mcpConfig, JSON.parse(readFileSync(mcpFile, "utf8")));
  }

  for (const field of COMPONENT_FIELDS) {
    const seg = componentSegment(manifest[field]);
    if (!seg) continue;
    const srcDir = join(dir, seg);
    if (!existsSync(srcDir)) continue;
    // agy reads the component by its convention name (`field`); point that at
    // the real source dir one level up so a non-conventional name still resolves.
    linkOrCopy(join("..", seg), join(stage, field), srcDir);
  }
}

export const antigravityAgent: Agent = {
  id: ID,
  displayName: "Antigravity",
  adaptTarget: "antigravity",
  detect: (env = process.env) => existsSync(antigravityHome(env)),
  available,

  activate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return { agent: ID, affected: [], skipped: true };
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      const dir = pluginStoreDir(ctx.pluginsDir, p);
      if (!dir) continue;
      writeAntigravityProjection(dir);
      if (run(["plugin", "install", join(dir, ANTIGRAVITY_PROJECTION_DIR)]).ok) affected.push(p);
    }
    return { agent: ID, affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    if (!available()) return { agent: ID, affected: [], skipped: true };
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      if (run(["plugin", "uninstall", p]).ok) affected.push(p);
    }
    return { agent: ID, affected, skipped: false };
  },

  // `agy plugin install` re-imports the source dir, so re-running it is the refresh.
  refresh(ctx: AgentContext): AgentSyncResult {
    return antigravityAgent.activate(ctx);
  },
};
