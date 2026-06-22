import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveProjectedSkills } from "../skills.ts";
import { isExposed } from "../components.ts";
import type { AdapterResult } from "./index.ts";

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
  if (manifest.hooks && isExposed(selection, "hooks")) out.hooks = manifest.hooks;
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
