import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AdgManifest, PluginSelection } from "./types.ts";

/** A resolved skill: its kebab-case name and the SKILL.md path (if one exists). */
export interface SkillEntry {
  name: string;
  skillMd?: string;
}

/**
 * Resolve the skills a plugin exposes, paired with their SKILL.md paths.
 *
 * - `skills` array → each entry's basename, SKILL.md resolved under the entry.
 * - otherwise → auto-scan the skills root for sub-dirs that contain a SKILL.md.
 */
export function resolveSkillEntries(pluginDir: string, manifest: AdgManifest): SkillEntry[] {
  const skills = manifest.skills;
  if (Array.isArray(skills)) {
    return skills.map((p) => {
      const rel = p.replace(/\/+$/, "");
      const name = rel.split("/").pop() ?? p;
      const abs = join(pluginDir, rel);
      let skillMd: string | undefined;
      if (existsSync(abs)) {
        const md = statSync(abs).isDirectory() ? join(abs, "SKILL.md") : abs;
        if (existsSync(md)) skillMd = md;
      }
      return { name, skillMd };
    });
  }
  const root = typeof skills === "string" ? skills : "./skills/";
  const abs = join(pluginDir, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(abs, e.name, "SKILL.md")))
    .map((e) => ({ name: e.name, skillMd: join(abs, e.name, "SKILL.md") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the list of skill names a plugin exposes.
 *
 * - `strict !== false` with an explicit `skills` array → that array (basenames).
 * - otherwise → auto-scan the skills root directory for sub-dirs that contain a
 *   SKILL.md file (skill names are the kebab-case directory names).
 */
export function resolveSkills(pluginDir: string, manifest: AdgManifest): string[] {
  return resolveSkillEntries(pluginDir, manifest).map((e) => e.name);
}

/** The skills a runtime manifest should project, and whether the list is explicit. */
export interface ProjectedSkills {
  /** Pass-through root/array form, or an explicit resolved skill-id list. */
  skills: string | string[];
  /**
   * True when `skills` is an explicit resolved id list (a partial-install
   * `selection`, a declared path array, or `strict: false`); false when it is a
   * pass-through of the declared root/array. Callers map ids to their runtime's
   * shape (Codex bare ids vs Claude `./skills/<id>` paths) and mark the manifest
   * non-strict only when explicit.
   */
  explicit: boolean;
}

/**
 * Decide the skills a forward adapter should project from an ADG manifest, the
 * one strict/selection decision both adapters share (previously copy-pasted, so
 * it could drift — see the Codex/Claude strict regression that motivated it).
 *
 * In the default strict case a declared skills *root* string is passed through
 * (the runtime discovers skills from the directory). Otherwise — a partial
 * install `selection`, a declared path array, or `strict: false` — an explicit
 * resolved id list is returned. `passthroughArray` keeps a strict array form
 * verbatim (Claude, whose array entries are already `./skills/<id>` paths)
 * rather than resolving it to ids (Codex, whose array form is bare ids).
 */
export function resolveProjectedSkills(
  pluginDir: string,
  manifest: AdgManifest,
  selection: PluginSelection | undefined,
  opts: { passthroughArray: boolean },
): ProjectedSkills {
  if (selection) {
    const skills = selection.components.includes("skills")
      ? selection.skills ?? resolveSkills(pluginDir, manifest)
      : [];
    return { skills, explicit: true };
  }
  const strict = manifest.strict !== false;
  const passthrough =
    strict &&
    (typeof manifest.skills === "string" ||
      (opts.passthroughArray && Array.isArray(manifest.skills)));
  if (passthrough) return { skills: manifest.skills as string | string[], explicit: false };
  return { skills: resolveSkills(pluginDir, manifest), explicit: true };
}

/** Read a SKILL.md's `description` from its YAML frontmatter (undefined if absent). */
export function readSkillDescription(skillMd: string): string | undefined {
  try {
    const head = readFileSync(skillMd, "utf8").slice(0, 4096);
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!m) return undefined;
    const fm = parseYaml(m[1] ?? "") as { description?: unknown } | null;
    const d = fm?.description;
    return typeof d === "string" && d.trim() ? d.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a lazy, cached description reader keyed by skill name. Files are only
 * read on the first lookup of each name (and never for skills the user doesn't
 * inspect), keeping the interactive picker free of upfront SKILL.md parsing.
 */
export function skillDescriptionLoader(
  pluginDir: string,
  manifest: AdgManifest,
): (name: string) => string | undefined {
  let paths: Map<string, string | undefined> | undefined;
  const cache = new Map<string, string | undefined>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    if (!paths) {
      paths = new Map(resolveSkillEntries(pluginDir, manifest).map((e) => [e.name, e.skillMd]));
    }
    const md = paths.get(name);
    const desc = md ? readSkillDescription(md) : undefined;
    cache.set(name, desc);
    return desc;
  };
}
