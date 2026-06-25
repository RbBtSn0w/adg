import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { toAnthropicManifest } from "../src/adapters/anthropic.ts";
import { toCodexManifest } from "../src/adapters/codex.ts";
import { type AdgManifest, type PluginSelection } from "../src/types.ts";
import { tmp, baseManifest } from "./helpers.ts";

test("anthropic adapter (strict) maps fields and keeps skills root", () => {
  const dir = tmp();
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, commands: "./commands/" });
  assert.equal(manifest.name, "demo");
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.commands, "./commands/");
  assert.equal(manifest.strict, undefined);
  rmSync(dir, { recursive: true });
});

test("anthropic adapter projects the apps directory", () => {
  const dir = tmp();
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, apps: "./apps/" });
  assert.equal(manifest.apps, "./apps/");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter omits a standard hooks/hooks.json (Claude auto-loads it)", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
  // ADG declares `hooks` as a directory; the standard hooks/hooks.json is loaded
  // automatically, so emitting it would "Duplicate hooks file detected".
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, hooks: "./hooks/" });
  assert.equal(manifest.hooks, undefined, "standard hooks file must be left to auto-load");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter resolves a hooks dir to its sole non-standard *.json file", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "config.json"), "{}");
  // A non-standard file is not auto-loaded, so it must be referenced as a file
  // (never a bare directory, which Claude rejects with `hooks: Invalid input`).
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, hooks: "./hooks/" });
  assert.equal(manifest.hooks, "./hooks/config.json");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter drops an explicit reference to the standard hooks file", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, hooks: "./hooks/hooks.json" });
  assert.equal(manifest.hooks, undefined, "explicit standard path must also be left to auto-load");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter omits hooks when the directory holds no resolvable config", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  // Ambiguous (two configs, no hooks.json) → emit nothing rather than an invalid dir.
  writeFileSync(join(dir, "hooks", "a.json"), "{}");
  writeFileSync(join(dir, "hooks", "b.json"), "{}");
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, hooks: "./hooks/" });
  assert.equal(manifest.hooks, undefined, "ambiguous/empty hooks dir must not emit a directory");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter drops hooks when not in the selection", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
  const manifest: AdgManifest = { ...baseManifest, hooks: "./hooks/" };
  const selection: PluginSelection = { components: ["skills"] };
  const out = toAnthropicManifest(dir, manifest, selection).manifest;
  assert.equal(out.hooks, undefined, "unselected hooks category must be dropped");
  rmSync(dir, { recursive: true });
});

test("codex adapter prefers the codex hook variant, else the standard file", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), "{}");
  writeFileSync(join(dir, "hooks", "hooks-codex.json"), "{}");
  // Codex has no auto-load: it needs an explicit file, and its own variant wins.
  const both = toCodexManifest(dir, { ...baseManifest, hooks: "./hooks/" }).manifest;
  assert.equal(both.hooks, "./hooks/hooks-codex.json");

  rmSync(join(dir, "hooks", "hooks-codex.json"));
  const standard = toCodexManifest(dir, { ...baseManifest, hooks: "./hooks/" }).manifest;
  assert.equal(standard.hooks, "./hooks/hooks.json", "falls back to the standard file");
  rmSync(dir, { recursive: true });
});

test("codex adapter omits hooks for an unresolvable dir or when not selected", () => {
  const dir = tmp();
  mkdirSync(join(dir, "hooks"), { recursive: true });
  // No *.json inside → nothing to reference.
  const empty = toCodexManifest(dir, { ...baseManifest, hooks: "./hooks/" }).manifest;
  assert.equal(empty.hooks, undefined, "empty hooks dir must not emit a directory");

  writeFileSync(join(dir, "hooks", "hooks-codex.json"), "{}");
  const selection: PluginSelection = { components: ["skills"] };
  const dropped = toCodexManifest(dir, { ...baseManifest, hooks: "./hooks/" }, selection).manifest;
  assert.equal(dropped.hooks, undefined, "unselected hooks category must be dropped");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter drops apps when not in the selection", () => {
  const dir = tmp();
  const manifest: AdgManifest = { ...baseManifest, apps: "./apps/" };
  const selection: PluginSelection = { components: ["skills"] };
  const out = toAnthropicManifest(dir, manifest, selection).manifest;
  assert.equal(out.apps, undefined, "unselected apps category must be dropped");
  rmSync(dir, { recursive: true });
});

test("anthropic adapter (non-strict) emits explicit skill list + strict:false", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, strict: false });
  assert.equal(manifest.strict, false);
  assert.deepEqual(manifest.skills, ["./skills/one"]);
  rmSync(dir, { recursive: true });
});

test("adapters honor a selection (narrow categories and skills)", () => {
  const dir = tmp();
  for (const s of ["one", "two"]) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), "x");
  }
  const manifest: AdgManifest = { ...baseManifest, commands: "./commands/", agents: "./agents/" };
  const selection: PluginSelection = { components: ["skills"], skills: ["one"] };

  const a = toAnthropicManifest(dir, manifest, selection).manifest;
  assert.equal(a.strict, false);
  assert.deepEqual(a.skills, ["./skills/one"]);
  assert.equal(a.commands, undefined, "unselected category must be dropped");
  assert.equal(a.agents, undefined);

  const c = toCodexManifest(dir, manifest, selection).manifest;
  assert.deepEqual(c.skills, ["one"]);
  rmSync(dir, { recursive: true });
});

test("codex adapter (strict) keeps the skills root (dir-form pass-through)", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  const { manifest, defaultPath } = toCodexManifest(dir, baseManifest);
  assert.equal(manifest.name, "demo");
  // Codex consumes the directory form natively; match Claude rather than
  // enumerating every skill id (which would drift as skills are added).
  assert.equal(manifest.skills, "./skills/");
  assert.ok(defaultPath.includes(".codex-plugin"));
  rmSync(dir, { recursive: true });
});

test("strict adapters default an omitted skills field to the ./skills/ root", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  // A strict manifest with no `skills` declaration must keep directory discovery
  // (root pass-through), not collapse to an explicit `strict: false` enumeration.
  const { skills, ...rest } = baseManifest;
  const manifest = rest as AdgManifest;

  const claude = toAnthropicManifest(dir, manifest).manifest;
  assert.equal(claude.skills, "./skills/");
  assert.equal(claude.strict, undefined, "omitted skills must not force strict:false");

  const codex = toCodexManifest(dir, manifest).manifest;
  assert.equal(codex.skills, "./skills/");
  rmSync(dir, { recursive: true });
});

test("codex adapter (non-strict) emits an explicit skill-id array", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  const { manifest } = toCodexManifest(dir, { ...baseManifest, strict: false });
  assert.deepEqual(manifest.skills, ["one"]);
  rmSync(dir, { recursive: true });
});

// ---- cross-adapter parity invariant ----
// Guards the drift class behind #3 / f8de95d, where the Codex adapter enumerated
// skills while Claude passed the `./skills/` root through, producing inconsistent
// skill sets across adapters as skills were added.

/**
 * Normalize either adapter's `skills` output to a comparable shape: the bare
 * directory-root sentinel, or a sorted set of skill ids — stripping Claude's
 * `./skills/` path prefix so its path array compares equal to Codex's bare ids.
 */
function normalizeSkills(skills: unknown): string {
  if (skills === "./skills/") return "<root>";
  if (Array.isArray(skills)) {
    return skills
      .map((s) => String(s).replace(/^\.\/skills\//, ""))
      .sort()
      .join(",");
  }
  return `<?:${JSON.stringify(skills)}>`;
}

test("adapters expose the same skill set for any manifest + selection", () => {
  const dir = tmp();
  for (const s of ["one", "two"]) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), "x");
  }
  const base: AdgManifest = { ...baseManifest, commands: "./commands/", agents: "./agents/" };
  const cases: { label: string; manifest: AdgManifest; selection?: PluginSelection }[] = [
    { label: "strict root pass-through", manifest: base },
    { label: "strict:false enumeration", manifest: { ...base, strict: false } },
    { label: "selection narrows skills", manifest: base, selection: { components: ["skills"], skills: ["one"] } },
    { label: "selection (all skills, narrowed categories)", manifest: base, selection: { components: ["skills", "commands"] } },
  ];
  for (const { label, manifest, selection } of cases) {
    const a = toAnthropicManifest(dir, manifest, selection).manifest;
    const c = toCodexManifest(dir, manifest, selection).manifest;
    assert.equal(
      normalizeSkills(a.skills),
      normalizeSkills(c.skills),
      `adapters must agree on the exposed skill set: ${label}`,
    );
  }
  rmSync(dir, { recursive: true });
});

test("codex adapter resolves an explicit skills path array to bare ids", () => {
  const dir = tmp();
  for (const s of ["one", "two"]) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), "x");
  }
  // Even strict: a declared path array is Codex's bare-id form, not a pass-through.
  const { manifest } = toCodexManifest(dir, {
    ...baseManifest,
    skills: ["./skills/one", "./skills/two"],
  });
  assert.deepEqual(manifest.skills, ["one", "two"]);
  rmSync(dir, { recursive: true });
});
