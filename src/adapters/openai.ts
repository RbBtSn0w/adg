import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveSkills } from "../skills.ts";
import { isExposed } from "../components.ts";
import type { AdapterResult } from "./index.ts";

/**
 * Generate a Codex (.codex-plugin/plugin.json) manifest from an ADG manifest.
 *
 * Codex's minimal manifest requires name, version, description and skills.
 * Mirroring the Claude adapter: in the default strict case the declared skills
 * root (e.g. `"./skills/"`) is passed through — Codex consumes the directory
 * form natively, so it discovers new skills without the manifest enumerating
 * them. A partial install (`selection`) or `strict: false` falls back to an
 * explicit array of skill identifiers. Codex only consumes skills.
 */
export function toCodexManifest(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  let skills: unknown;
  if (selection) {
    skills = isExposed(selection, "skills")
      ? selection.skills ?? resolveSkills(pluginDir, manifest)
      : [];
  } else {
    const strict = manifest.strict !== false;
    skills = strict && manifest.skills !== undefined
      ? manifest.skills
      : resolveSkills(pluginDir, manifest);
  }

  const out: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    skills,
  };

  if (manifest.author) out.author = manifest.author;
  if (manifest.homepage) out.homepage = manifest.homepage;
  if (manifest.license) out.license = manifest.license;

  return { defaultPath: join(".codex-plugin", "plugin.json"), manifest: out };
}
