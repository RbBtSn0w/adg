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
    const result = await inspectSource({
      spec: "owner/skills",
      gitRunner: (args) => cpSync(remote, args[args.length - 1]!, { recursive: true }),
      descriptionResolver: async () => undefined,
    });
    assert.equal(result.manifest.name, "owner-skills");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inspectSource matches add metadata for a remote Default DSL source", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-description-"));
  const remote = join(root, "remote");
  const gitRunner = (args: string[]) => cpSync(remote, args[args.length - 1]!, { recursive: true });
  try {
    mkdirSync(join(remote, "skills", "demo"), { recursive: true });
    writeFileSync(join(remote, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo.\n---\n");

    const described = await inspectSource({
      spec: "owner/skills",
      gitRunner,
      descriptionResolver: async () => "Repository About.",
    });
    assert.equal(described.manifest.description, "Repository About.");

    const fallback = await inspectSource({
      spec: "owner/skills",
      gitRunner,
      descriptionResolver: async () => undefined,
    });
    assert.equal(fallback.manifest.description, "owner/skills");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inspectSource does not resolve Default DSL metadata for an explicit manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-inspect-manifest-"));
  const remote = join(root, "remote");
  try {
    mkdirSync(join(remote, ".agents"), { recursive: true });
    writeFileSync(join(remote, ".agents", ".plugin.json"), JSON.stringify({
      schemaVersion: "adg.plugin/v1",
      name: "explicit",
      version: "1.0.0",
      description: "Explicit manifest.",
    }));
    const result = await inspectSource({
      spec: "owner/explicit",
      gitRunner: (args) => cpSync(remote, args[args.length - 1]!, { recursive: true }),
      descriptionResolver: async () => { throw new Error("unexpected metadata lookup"); },
    });
    assert.equal(result.kind, "manifest");
    assert.equal(result.manifest.description, "Explicit manifest.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
