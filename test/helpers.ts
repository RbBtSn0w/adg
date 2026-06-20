// Shared fixtures for the unit suite. Not a *.test.ts file, so the test runner
// imports it without treating it as a test module.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ADG_SCHEMA_VERSION, type AdgManifest } from "../src/types.ts";
import { ADG_MANIFEST_PATH, LEGACY_MANIFEST_PATH } from "../src/manifest.ts";

/** A fresh temp directory under the OS tmpdir. Callers clean it up. */
export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-"));
}

/** A minimal valid manifest, reused across adapter/skills/validation tests. */
export const baseManifest: AdgManifest = {
  schemaVersion: ADG_SCHEMA_VERSION,
  name: "demo",
  version: "1.2.3",
  description: "Demo plugin.",
  skills: "./skills/",
  strict: true,
};

/**
 * Scaffold a plugin source containing a declared skill, metadata, and dev cruft
 * that must never ship. Used by packaging and legacy-back-compat tests.
 */
export function scaffoldSource(
  root: string,
  opts: { legacy?: boolean } = {},
): { dir: string; manifest: AdgManifest } {
  const dir = join(root, "pkgdemo");
  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "pkgdemo",
    version: "0.1.0",
    description: "Packaging demo.",
    skills: "./skills/",
  };
  const mfFile = join(dir, opts.legacy ? LEGACY_MANIFEST_PATH : ADG_MANIFEST_PATH);
  mkdirSync(dirname(mfFile), { recursive: true });
  writeFileSync(mfFile, JSON.stringify(manifest));
  mkdirSync(join(dir, "skills", "hello"), { recursive: true });
  writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi.\n---\n");
  writeFileSync(join(dir, "README.md"), "# pkgdemo\n");
  // Dev cruft that must never ship.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "a.test.ts"), "// test\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  return { dir, manifest };
}
