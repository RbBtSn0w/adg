import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPlugin, inspectSource } from "../src/commands/inspect.ts";
import { validatePlugin } from "../src/commands/validate.ts";

test("inspectPlugin reports the default DSL without writing a manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-"));
  try {
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const result = inspectPlugin(root);
    assert.equal(result.kind, "default-dsl");
    assert.deepEqual(result.components, ["skills"]);
    assert.equal(validatePlugin(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inspectSource rejects a --path that escapes a local source root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "adg-inspect-parent-"));
  try {
    const source = join(parent, "source");
    mkdirSync(join(source, "skills", "demo"), { recursive: true });
    writeFileSync(join(source, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    await assert.rejects(() => inspectSource({ spec: source, path: "../outside" }), /path must stay within the source root/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("inspectSource rejects Default DSL under --path", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-root-"));
  try {
    const subdir = join(root, "packages", "skills");
    mkdirSync(join(subdir, "skills", "demo"), { recursive: true });
    writeFileSync(join(subdir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    await assert.rejects(() => inspectSource({ spec: root, path: "packages/skills" }), /Default DSL only supports the source root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inspectSource rejects a --path symlink that escapes the source root", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-root-"));
  const external = mkdtempSync(join(tmpdir(), "adg-inspect-external-"));
  try {
    mkdirSync(join(external, ".agents"), { recursive: true });
    writeFileSync(join(external, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: "adg.plugin/v1", name: "external", version: "1.0.0", description: "External.",
    }));
    symlinkSync(external, join(root, "external"), "dir");
    await assert.rejects(() => inspectSource({ spec: root, path: "external" }), /path must stay within the source root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
