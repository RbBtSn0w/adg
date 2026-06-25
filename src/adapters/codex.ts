import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { resolveProjectedSkills } from "../skills.ts";
import { isExposed } from "../components.ts";
import type { AdapterResult } from "./index.ts";

/**
 * Resolve the hooks config *file* Codex should reference. ADG declares `hooks` as
 * a directory, but Codex (unlike Claude) has no auto-load — it needs an explicit
 * file path. Prefer a Codex-specific variant (`hooks/hooks-codex.json`, the
 * convention upstream plugins like superpowers use), else the standard
 * `hooks/hooks.json`. An explicit `*.json` reference passes through; an
 * unresolvable directory yields undefined so the caller omits `hooks`.
 */
export function resolveCodexHooksFile(pluginDir: string, hooks: string): string | undefined {
  const rel = hooks.replace(/\/+$/, "");
  const abs = join(pluginDir, rel);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    for (const candidate of ["hooks-codex.json", "hooks.json"]) {
      if (existsSync(join(abs, candidate))) return `${rel}/${candidate}`;
    }
    return undefined;
  }
  // A file (or a path missing on disk): only trust an explicit *.json reference.
  return hooks.endsWith(".json") ? hooks : undefined;
}

/**
 * Generate a Codex (.codex-plugin/plugin.json) manifest from an ADG manifest.
 *
 * Codex's minimal manifest requires name, version, description and skills.
 * In the default strict case a declared skills *root* string (e.g. `"./skills/"`)
 * is passed through — Codex consumes the directory form natively, so it
 * discovers new skills without the manifest enumerating them. Every other case
 * (an explicit `skills` array, a partial install `selection`, or `strict: false`)
 * emits the bare skill-id array Codex expects: `manifest.skills` arrays are
 * declared as *paths* (`./skills/foo`), so they are resolved to identifiers
 * rather than passed through. Beyond skills, Codex also consumes `hooks` — but as
 * an explicit config *file* (no auto-load), so a declared hooks directory is
 * resolved to its Codex-variant file via `resolveCodexHooksFile`.
 */
export function toCodexManifest(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdapterResult {
  // Codex's array form is bare ids, so a strict skills *array* is resolved to
  // ids rather than passed through; only a declared root string passes through.
  const { skills } = resolveProjectedSkills(pluginDir, manifest, selection, { passthroughArray: false });

  const out: Record<string, unknown> = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    skills,
  };

  if (manifest.author) out.author = manifest.author;
  if (manifest.homepage) out.homepage = manifest.homepage;
  if (manifest.license) out.license = manifest.license;
  if (manifest.hooks && isExposed(selection, "hooks")) {
    const hooksFile = resolveCodexHooksFile(pluginDir, manifest.hooks);
    if (hooksFile) out.hooks = hooksFile;
  }

  return { defaultPath: join(".codex-plugin", "plugin.json"), manifest: out };
}
