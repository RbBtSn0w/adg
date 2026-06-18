import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveSkills } from "../skills.ts";
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

  if (selection) {
    // Partial install: always an explicit (possibly empty) skill list.
    out.strict = false;
    const names = isExposed(selection, "skills")
      ? selection.skills ?? resolveSkills(pluginDir, manifest)
      : [];
    out.skills = names.map((name) => `./skills/${name}`);
  } else {
    const strict = manifest.strict !== false;
    if (strict && manifest.skills !== undefined) {
      out.skills = manifest.skills;
    } else {
      // skill-bundle form: explicit list, strict:false
      out.strict = false;
      out.skills = resolveSkills(pluginDir, manifest).map((name) => `./skills/${name}`);
    }
  }

  return { defaultPath: join(".claude-plugin", "plugin.json"), manifest: out };
}
