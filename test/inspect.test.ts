import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("inspectSource namespaces a remote Default DSL identity by owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-remote-"));
  const remote = join(root, "remote");
  try {
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");
    const result = await inspectSource({ spec: "owner/skills", gitRunner: (args) => cpSync(remote, args[args.length - 1]!, { recursive: true }) });
    assert.equal(result.manifest.name, "owner-skills");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
