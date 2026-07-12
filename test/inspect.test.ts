import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
