import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveSkills } from "../skills.ts";
import { isExposed } from "../components.ts";
import type { AdapterResult } from "./index.ts";

/**
 * Generate a Codex (.codex-plugin/plugin.json) manifest from an ADG manifest.
 *
 * Codex's minimal manifest requires name, version, description and skills. The
 * skills field is emitted as an explicit array of skill identifiers. An optional
 * `selection` narrows the exposed skills (Codex only consumes skills).
 */
export function toCodexManifest(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  const skills = !selection
    ? resolveSkills(pluginDir, manifest)
    : isExposed(selection, "skills")
      ? selection.skills ?? resolveSkills(pluginDir, manifest)
      : [];

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
