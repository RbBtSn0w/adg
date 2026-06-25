import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveProjectedSkills } from "../skills.ts";
import { isExposed } from "../components.ts";
import type { AdapterResult } from "./index.ts";

/**
 * Claude auto-loads this plugin-relative path; declaring it in `manifest.hooks`
 * duplicates the load and fails ("Duplicate hooks file detected").
 */
const STANDARD_HOOKS = "hooks/hooks.json";

/**
 * Translate ADG's `hooks` (a *directory*, per the universal manifest) into the
 * value Claude's plugin.json expects, or undefined to omit the field.
 *
 * Two Claude rules drive this:
 *  - `hooks` must be a config *file*, not a directory — a bare `./hooks/` is
 *    rejected with `hooks: Invalid input`, breaking `claude plugin install`.
 *  - the standard `hooks/hooks.json` is loaded automatically, so `manifest.hooks`
 *    must reference only *additional* files — repeating the standard path fails
 *    to load with "Duplicate hooks file detected".
 *
 * So: resolve the directory to its config file (conventional `hooks.json`, else
 * its sole `*.json`), pass an explicit `*.json` reference through, and return
 * undefined when the result is unresolvable/ambiguous OR is the auto-loaded
 * standard path — in every "undefined" case the caller omits `hooks`.
 */
export function resolveClaudeHooksFile(pluginDir: string, hooks: string): string | undefined {
  const rel = hooks.replace(/\/+$/, "");
  const abs = join(pluginDir, rel);

  let file: string | undefined;
  if (existsSync(abs) && statSync(abs).isFile()) {
    file = hooks.endsWith(".json") ? hooks : undefined;
  } else if (existsSync(abs) && statSync(abs).isDirectory()) {
    if (existsSync(join(abs, "hooks.json"))) file = `${rel}/hooks.json`;
    else {
      const jsons = readdirSync(abs).filter((f) => f.endsWith(".json"));
      file = jsons.length === 1 ? `${rel}/${jsons[0]}` : undefined;
    }
  } else {
    // Path missing on disk: only trust an explicit file reference.
    file = hooks.endsWith(".json") ? hooks : undefined;
  }

  if (!file) return undefined;
  // Drop the auto-loaded standard path; only non-standard hook files belong here.
  return file.replace(/^\.\//, "") === STANDARD_HOOKS ? undefined : file;
}

/**
 * Generate a Claude (.claude-plugin/plugin.json) manifest from an ADG manifest.
 *
 * Maps the universal fields onto Claude's plugin shape. When `strict` is false,
 * skills are listed explicitly so a skill-bundle marketplace entry can be built.
 * An optional `selection` narrows what is exposed (partial install): categories
 * outside it are dropped and skills are pinned to an explicit subset list.
 */
export function toAnthropicManifest(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  const out: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  };

  if (manifest.author) out.author = manifest.author;
  if (manifest.homepage) out.homepage = manifest.homepage;
  if (manifest.license) out.license = manifest.license;
  if (manifest.category) out.category = manifest.category;
  if (manifest.commands && isExposed(selection, "commands")) out.commands = manifest.commands;
  if (manifest.agents && isExposed(selection, "agents")) out.agents = manifest.agents;
  if (manifest.hooks && isExposed(selection, "hooks")) {
    const hooksFile = resolveClaudeHooksFile(pluginDir, manifest.hooks);
    if (hooksFile) out.hooks = hooksFile;
  }
  if (manifest.mcp && isExposed(selection, "mcp")) out.mcp = manifest.mcp;
  if (manifest.apps && isExposed(selection, "apps")) out.apps = manifest.apps;

  // Claude's array form is already `./skills/<id>` paths, so a strict array is
  // passed through verbatim; an explicit id list (selection or strict:false) is
  // mapped to paths and marks the manifest non-strict.
  const projected = resolveProjectedSkills(pluginDir, manifest, selection, { passthroughArray: true });
  if (projected.explicit) {
    out.strict = false;
    out.skills = (projected.skills as string[]).map((name) => `./skills/${name}`);
  } else {
    out.skills = projected.skills;
  }

  return { defaultPath: join(".claude-plugin", "plugin.json"), manifest: out };
}
