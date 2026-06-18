import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ADG_MANIFEST_PATH } from "../manifest.ts";
import { writeJson, writeText } from "../fsutil.ts";
import { installPlugin, type InstallResult } from "./install.ts";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "../types.ts";

export interface ImportSkillsOptions {
  /** Directory holding flat <name>/SKILL.md skill folders. */
  skillsDir: string;
  /** Name of the synthesized plugin. */
  as: string;
  /** Only include skills whose folder name starts with this prefix. */
  prefix?: string;
  pluginsDir: string;
  version?: string;
  description?: string;
  marketplaceName?: string;
  now?: string;
}

/**
 * Wrap a flat directory of `<name>/SKILL.md` skills into a single ADG plugin and
 * install it. Skill folders are copied verbatim under the new plugin's skills/.
 */
export function importSkills(opts: ImportSkillsOptions): InstallResult {
  const src = resolve(opts.skillsDir);
  const names = readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(src, e.name, "SKILL.md")))
    .map((e) => e.name)
    .filter((name) => !opts.prefix || name.startsWith(opts.prefix))
    .sort();

  if (names.length === 0) {
    throw new Error(`no SKILL.md skills found in ${src}${opts.prefix ? ` with prefix "${opts.prefix}"` : ""}`);
  }

  const staging = mkdtempSync(join(tmpdir(), "adg-skills-"));
  try {
    const manifest: AdgManifest = {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: opts.as,
      version: opts.version ?? "0.1.0",
      description: opts.description ?? `Imported skills bundle (${names.length}).`,
      skills: "./skills/",
      strict: false,
    };
    writeJson(join(staging, ADG_MANIFEST_PATH), manifest);
    for (const name of names) {
      copySkill(join(src, name), join(staging, "skills", name));
    }
    writeText(join(staging, "README.md"), `# ${opts.as}\n\n${manifest.description}\n`);

    return installPlugin({
      source: staging,
      pluginsDir: opts.pluginsDir,
      origin: { type: "local", path: `./${opts.as}` },
      marketplaceName: opts.marketplaceName,
      now: opts.now,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function copySkill(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}
