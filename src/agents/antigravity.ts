import { cpSync, existsSync, lstatSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ensureDir, writeJson } from "../fsutil.ts";
import { readManifest } from "../manifest.ts";
import { isExposed } from "../components.ts";
import { installedPluginDir, lockPath } from "../paths.ts";
import { readLock } from "../lock.ts";
import { toAntigravityManifest, writeAntigravityMcpConfig } from "../adapters/antigravity.ts";
import { skippedResult } from "./base.ts";
import type { AdgManifest, ComponentType, PluginSelection } from "../types.ts";
import type { Agent, AgentContext, AgentSyncResult } from "./types.ts";

/**
 * Antigravity (`agy`) agent — physical-directory model, no CLI.
 *
 * Antigravity discovers plugins by *scanning* designated directories; the
 * directory itself carries the scope (the provenance), and there is no agy lock
 * or marketplace:
 *   - Workspace: `<ws>/.agents/plugins/<name>` (ADG's own project store)
 *   - Global:    `~/.gemini/config/plugins/<name>`
 * A plugin folder is recognized by a root `plugin.json` plus sibling component
 * dirs (`skills/ agents/ commands/ hooks/`).
 *
 * We therefore drive Antigravity purely by placing files, never by a CLI:
 *   - Project scope is *in place*: ADG's store folder already sits in the
 *     workspace scan dir, so we just write the agy `plugin.json` at its root.
 *   - Global scope (and remote-nested project plugins, which live two levels
 *     under the scan dir) get an exposure symlink `<scanDir>/<name>` -> the real
 *     store folder, with a copy fallback where symlinks are unavailable.
 *
 * Provenance is owned by ADG: `listInstalled` answers from the queried scope's
 * own lock intersected with that scope's scan dir — never from the agent — so a
 * project query can't surface globally-installed plugins (and vice versa).
 *
 * Tradeoff (in-place): partial installs are best-effort, and a `skills` value is
 * read from the single convention dir `<plugin>/skills/`. Generated
 * `mcp_config.json` honors the MCP selection, but an authored file already using
 * that conventional name cannot be hidden without deleting canonical payload.
 * The auto-scan model also does NOT honor: dir-level pruning (a narrowed skill
 * subset, a dropped directory category), nor a multi-root skills path-list (e.g.
 * `["./skills/one","./extra/two"]` — only the `skills/` root is exposed; `extra/`
 * is not). These would require a separate self-contained projection dir, which the
 * in-place model deliberately avoids; the full canonical dirs are read in place.
 */

const ID = "antigravity";

/** The manifest filename Antigravity's auto-scan looks for at a plugin folder root. */
const ANTIGRAVITY_MANIFEST = "plugin.json";

/**
 * Component fields agy reads as a sibling dir named by convention. We ensure each
 * resolves under its convention name, aliasing when the manifest declares a
 * non-convention source dir.
 */
const CONVENTION_FIELDS = ["skills", "agents", "commands", "hooks"] as const satisfies readonly ComponentType[];

function geminiHome(env: NodeJS.ProcessEnv): string {
  return env.GEMINI_HOME?.trim() || join(homedir(), ".gemini");
}

/**
 * Antigravity-specific markers under the Gemini home. `~/.gemini` itself is
 * shared with the plain Gemini CLI, so detection keys on an `antigravity*` dir to
 * avoid falsely registering a Gemini-CLI-only user (and writing into their home).
 */
const ANTIGRAVITY_MARKERS = ["antigravity", "antigravity-cli", "antigravity-ide"] as const;

function antigravityPresent(env: NodeJS.ProcessEnv): boolean {
  const home = geminiHome(env);
  return ANTIGRAVITY_MARKERS.some((marker) => existsSync(join(home, marker)));
}

/**
 * Antigravity's global plugin scan dir: `<GEMINI_HOME>/config/plugins`
 * (defaulting to `~/.gemini/config/plugins`). Exported so the resolver is
 * testable without host filesystem state.
 */
export function antigravityGlobalPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(geminiHome(env), "config", "plugins");
}

/** The scan dir Antigravity reads for a given scope: global home, or the project store itself. */
function antigravityScanDir(ctx: AgentContext, env: NodeJS.ProcessEnv = process.env): string {
  return ctx.scope === "user" ? antigravityGlobalPluginsDir(env) : ctx.pluginsDir;
}

/**
 * Symlink `linkPath` at `absTarget` (target stored relative so the link survives
 * a move), copying instead where symlinks are unavailable (e.g. Windows without
 * privilege). Idempotent.
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

/**
 * Remove `path` when it is a symlink — including a *broken* one. `lstatSync` (in a
 * `try`) is used rather than `existsSync`, which follows the link and reports false
 * for a dangling alias, leaving it on disk. Removal uses `unlinkSync`, not
 * `rmSync(..., { force: true })`: on Node < 24 the latter follows the link, hits
 * `ENOENT`, and the `force` flag then swallows it without unlinking the symlink.
 * A real file/dir is left untouched.
 */
function rmIfSymlink(path: string): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(path);
  } catch {
    return; // absent
  }
  if (st.isSymbolicLink()) unlinkSync(path);
}

/** First on-disk top segment of a declared component path (e.g. "./agents/" -> "agents"). */
function componentSegment(value: AdgManifest[keyof AdgManifest]): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return undefined;
  const seg = first.replace(/^\.?[/\\]/, "").split(/[/\\]/)[0];
  return seg || undefined;
}

/**
 * Make `dir` a valid agy plugin root in place: write the agy `plugin.json` at the
 * root and ensure each exposed component resolves under its convention name
 * (aliasing with a symlink/copy only when the manifest's source dir name differs).
 * Idempotent; safe to re-run. Never deletes a real (non-symlink) component dir.
 */
export function ensureAntigravityRoot(dir: string, selection?: PluginSelection): void {
  const manifest = readManifest(dir);
  const { manifest: pluginJson } = toAntigravityManifest(dir, manifest, selection);
  writeJson(join(dir, ANTIGRAVITY_MANIFEST), pluginJson);
  writeAntigravityMcpConfig(dir, manifest, selection);

  for (const field of CONVENTION_FIELDS) {
    const link = join(dir, field);
    rmIfSymlink(link); // clear a stale alias (incl. a broken one); a real source dir is left untouched
    if (!isExposed(selection, field)) continue;
    const seg = componentSegment(manifest[field]);
    if (!seg || seg === field) continue; // absent, or already convention-named in place
    const src = join(dir, seg);
    if (existsSync(src)) linkOrCopy(link, src);
  }
}

/**
 * Expose `realDir` to Antigravity at `<scanDir>/<name>`. No-op when the real dir
 * already *is* that path (project, flat). Returns false without touching disk when
 * the target is a real directory ADG didn't create (no agy manifest) — we never
 * clobber a plugin slot we don't own. Replacing our own alias or a prior
 * projection (which carries the manifest) is fine.
 */
function exposeAt(scanDir: string, name: string, realDir: string): boolean {
  const target = join(scanDir, name);
  if (resolve(target) === resolve(realDir)) return true; // project, flat: already in the scan dir
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(target);
  } catch {
    existing = undefined; // absent — safe to create
  }
  if (existing?.isDirectory() && !existing.isSymbolicLink() && !existsSync(join(target, ANTIGRAVITY_MANIFEST))) {
    console.error(
      `antigravity: skipping "${name}" — ${target} already exists and is not ADG-managed. ` +
        `Remove it to let ADG manage this plugin.`,
    );
    return false;
  }
  linkOrCopy(target, realDir);
  return true;
}

/**
 * Tear down a plugin's projection. When the real store dir is known, drop its agy
 * manifest and any convention alias links (in-place cleanup). Remove the external
 * exposure entry only when it is our own alias (a symlink) or a copy-fallback dir
 * that carries the manifest — never recursively delete an unattributable dir, and
 * never the in-place store folder itself.
 */
function removeProjection(scanDir: string, name: string, realDir?: string): void {
  const target = join(scanDir, name);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(target);
  } catch {
    st = undefined;
  }

  if (realDir) {
    // The real store dir is known: drop the in-place manifest + convention aliases.
    rmSync(join(realDir, ANTIGRAVITY_MANIFEST), { force: true });
    writeAntigravityMcpConfig(realDir, readManifest(realDir), { components: [] });
    for (const field of CONVENTION_FIELDS) rmIfSymlink(join(realDir, field));
    if (resolve(target) === resolve(realDir)) return; // in-place: target IS the store folder — never delete it
    // Aliased exposure we created (symlink, or a copy-fallback dir): safe to drop wholesale.
    if (st) rmSync(target, { recursive: true, force: true });
    return;
  }

  // Real dir unknown (e.g. the store entry is already gone): we cannot prove a real
  // directory at `target` is our exposure vs. a store/foreign folder, so only ever
  // remove a symlink alias — never recursively delete an unattributable directory.
  if (st?.isSymbolicLink()) rmSync(target, { force: true });
}

/** Resolve a plugin's on-disk dir and selection from the lock, or undefined when not installed. */
function pluginRealDir(pluginsDir: string, name: string): { dir: string; selection?: PluginSelection } | undefined {
  const entry = readLock(lockPath(pluginsDir)).plugins[name];
  if (!entry) return undefined;
  const dir = installedPluginDir(pluginsDir, name, entry.origin);
  return existsSync(dir) ? { dir, selection: entry.selection } : undefined;
}

export const antigravityAgent: Agent = {
  id: ID,
  displayName: "Antigravity",
  adaptTarget: "antigravity",
  // The directory model needs no CLI: an `antigravity*` marker under the Gemini
  // home is the signal that Antigravity is installed and its scan dirs are real.
  detect: (env = process.env) => antigravityPresent(env),
  available: () => antigravityPresent(process.env),

  activate(ctx: AgentContext): AgentSyncResult {
    if (!antigravityAgent.detect()) return skippedResult(ID);
    const scanDir = antigravityScanDir(ctx);
    ensureDir(scanDir);
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      // Isolate each plugin: a malformed manifest or fs error must not abort the rest.
      try {
        const real = pluginRealDir(ctx.pluginsDir, p);
        if (!real) continue;
        ensureAntigravityRoot(real.dir, real.selection);
        if (exposeAt(scanDir, p, real.dir)) affected.push(p);
      } catch (err) {
        console.error(`failed to enable "${p}" in Antigravity:`, err);
      }
    }
    return { agent: ID, affected, skipped: false };
  },

  deactivate(ctx: AgentContext): AgentSyncResult {
    if (!antigravityAgent.detect()) return skippedResult(ID);
    const scanDir = antigravityScanDir(ctx);
    const lock = readLock(lockPath(ctx.pluginsDir)).plugins;
    const affected: string[] = [];
    for (const p of ctx.plugins) {
      const entry = lock[p];
      const realDir = entry ? installedPluginDir(ctx.pluginsDir, p, entry.origin) : undefined;
      removeProjection(scanDir, p, realDir);
      affected.push(p);
    }
    return { agent: ID, affected, skipped: false };
  },

  // Re-running activate is the refresh: it rewrites the manifest and re-exposes
  // the store dir, so a changed plugin replaces its stale projection in place.
  refresh(ctx: AgentContext): AgentSyncResult {
    return antigravityAgent.activate(ctx);
  },

  // Provenance is ADG's, not the agent's: enumerate the queried scope's own lock
  // and keep only plugins Antigravity actually sees in that scope's scan dir (a
  // root `plugin.json`, reached directly or via the exposure link). A project
  // query therefore can't surface globally-installed plugins. `undefined` only
  // when Antigravity isn't present at all ("unknown"), never confused with empty.
  listInstalled(ctx: AgentContext): string[] | undefined {
    if (!antigravityAgent.detect()) return undefined;
    const scanDir = antigravityScanDir(ctx);
    const names = Object.keys(readLock(lockPath(ctx.pluginsDir)).plugins);
    return names.filter((name) => existsSync(join(scanDir, name, ANTIGRAVITY_MANIFEST)));
  },
};
