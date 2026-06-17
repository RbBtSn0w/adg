import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { PluginSource } from "./types.ts";

export const LOCK_FILENAME = ".plugin-lock.json";
export const MARKETPLACE_FILENAME = "marketplace.json";

/**
 * Resolve the global plugins directory.
 *
 * Honors ADG_PLUGINS_HOME, then XDG_STATE_HOME/.agents/plugins, falling back to
 * ~/.agents/plugins. Only the `plugins/` subtree is ever managed by ADG — the
 * sibling AGENTS.md and skills/ are never read or written by this tool.
 */
export function globalPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADG_PLUGINS_HOME) return env.ADG_PLUGINS_HOME;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, ".agents", "plugins");
  return join(homedir(), ".agents", "plugins");
}

/**
 * Resolve the project plugins directory by walking up from `start` to find a
 * `.agents/plugins` directory or a repo root (`.git`); defaults to
 * `<start>/.agents/plugins` when none is found.
 */
export function projectPluginsDir(start: string = process.cwd()): string {
  let dir = start;
  while (true) {
    const candidate = join(dir, ".agents", "plugins");
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(start, ".agents", "plugins");
    dir = parent;
  }
}

/**
 * Resolve Claude's skills-directory plugin root, where a symlinked plugin
 * auto-loads as `<name>@skills-dir`. Global → ~/.claude/skills, project →
 * <cwd>/.claude/skills. This is Claude's own directory, distinct from the
 * never-touched ~/.agents/skills.
 */
export function claudeSkillsDir(global: boolean, cwd: string = process.cwd()): string {
  return global ? join(homedir(), ".claude", "skills") : join(cwd, ".claude", "skills");
}

export function lockPath(pluginsDir: string): string {
  return join(pluginsDir, LOCK_FILENAME);
}

export function marketplacePath(pluginsDir: string): string {
  return join(pluginsDir, MARKETPLACE_FILENAME);
}

/**
 * Make a filesystem-safe single path segment out of a git URL by replacing the
 * scheme/host/path separators with `__` and dropping a trailing `.git`.
 */
function sanitizeGitUrl(url: string): string {
  return url
    .replace(/\.git$/, "")
    .replace(/[:/@]+/g, "__")
    .replace(/^_+|_+$/g, "");
}

/**
 * The directory bucket a plugin's files live under, grouped by the source it
 * came from: remote sources nest beneath a per-marketplace segment
 * (`owner/repo` → `owner__repo`), while local installs stay flat (return null).
 * This is the on-disk grouping only — plugin name remains the unique key in the
 * lock and marketplace.json.
 */
export function sourceDirSegment(origin: PluginSource): string | null {
  switch (origin.type) {
    case "local":
      return null;
    case "github":
      return origin.repo.replaceAll("/", "__");
    case "git":
      return sanitizeGitUrl(origin.url);
  }
}

/**
 * Resolve where a plugin's files are installed: `<pluginsDir>/<segment>/<name>`
 * for remote sources, or the flat `<pluginsDir>/<name>` for local installs.
 */
export function pluginDir(pluginsDir: string, name: string, origin: PluginSource): string {
  const seg = sourceDirSegment(origin);
  return seg ? join(pluginsDir, seg, name) : join(pluginsDir, name);
}

/**
 * Resolve a plugin's *actual* on-disk directory. Prefers the canonical
 * per-marketplace nested path, but falls back to the flat `<pluginsDir>/<name>`
 * for installs made before the nested layout (and not yet `migrate`d). Returns
 * the canonical nested path when neither exists.
 */
export function installedPluginDir(pluginsDir: string, name: string, origin: PluginSource): string {
  const nested = pluginDir(pluginsDir, name, origin);
  if (existsSync(nested)) return nested;
  const flat = join(pluginsDir, name);
  if (existsSync(flat)) return flat;
  return nested;
}

/**
 * The `source.path` to record in marketplace.json for a plugin at `dest`.
 *
 * For the canonical store layout `<root>/.agents/plugins`, Codex discovers the
 * marketplace via the root that *contains* `.agents/` and resolves each entry's
 * `source.path` relative to that root — so the path keeps its `.agents/plugins/`
 * prefix (e.g. `./.agents/plugins/owner__repo/name`) for `codex plugin add` to
 * find it.
 *
 * Any other store (an explicit `--dir <path>`) has no `.agents/` ancestor to
 * resolve against; `dest` always lives *inside* `pluginsDir`, so we record a
 * path relative to the store dir itself (e.g. `./name` or `./segment/name`).
 * This stays correct regardless of where or how deep the store sits, instead of
 * leaking parent-directory names from a fixed two-levels-up assumption.
 */
export function marketplaceSourcePath(pluginsDir: string, dest: string): string {
  const isCanonical =
    basename(pluginsDir) === "plugins" && basename(dirname(pluginsDir)) === ".agents";
  const root = isCanonical ? dirname(dirname(pluginsDir)) : pluginsDir;
  return `./${relative(root, dest).split("\\").join("/")}`;
}
