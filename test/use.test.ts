import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseUseOptions,
  buildUsePrompt,
  materializeUseSkill,
  launchAgentInteractively,
  type AgentSpawn,
  type AgentProcess,
  type UseSkill,
} from "../vendor/skills/src/use.ts";

function tmp(prefix = "adg-use-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- parseUseOptions ----

test("parseUseOptions: bare source", () => {
  const { source, options, errors } = parseUseOptions(["owner/repo"]);
  assert.deepEqual(source, ["owner/repo"]);
  assert.deepEqual(options, {});
  assert.deepEqual(errors, []);
});

test("parseUseOptions: keeps the @selector in the source token", () => {
  const { source, errors } = parseUseOptions(["owner/repo@my-skill"]);
  assert.deepEqual(source, ["owner/repo@my-skill"]);
  assert.deepEqual(errors, []);
});

test("parseUseOptions: --skill / -s consume one value", () => {
  assert.equal(parseUseOptions(["owner/repo", "--skill", "foo"]).options.skill, "foo");
  assert.equal(parseUseOptions(["owner/repo", "-s", "bar"]).options.skill, "bar");
});

test("parseUseOptions: --skill without a value errors", () => {
  const { errors } = parseUseOptions(["owner/repo", "--skill"]);
  assert.ok(errors.some((e) => e.includes("requires a skill name")));
});

test("parseUseOptions: duplicate --skill errors", () => {
  const { errors } = parseUseOptions(["owner/repo", "-s", "a", "-s", "b"]);
  assert.ok(errors.some((e) => e.includes("Only one --skill value")));
});

test("parseUseOptions: --agent takes exactly one value and does not swallow the source", () => {
  const { source, options, errors } = parseUseOptions(["--agent", "claude-code", "owner/repo"]);
  assert.deepEqual(options.agent, ["claude-code"]);
  assert.deepEqual(source, ["owner/repo"]);
  assert.deepEqual(errors, []);
});

test("parseUseOptions: source before --agent also works", () => {
  const { source, options, errors } = parseUseOptions(["owner/repo", "-a", "codex"]);
  assert.deepEqual(options.agent, ["codex"]);
  assert.deepEqual(source, ["owner/repo"]);
  assert.deepEqual(errors, []);
});

test("parseUseOptions: repeated --agent is rejected", () => {
  const { errors } = parseUseOptions(["owner/repo", "--agent", "claude-code", "--agent", "codex"]);
  assert.ok(errors.some((e) => e.includes("accepts exactly one agent")));
});

test("parseUseOptions: unsupported agent reports the supported set", () => {
  const { errors } = parseUseOptions(["owner/repo", "--agent", "cursor"]);
  const msg = errors.join("\n");
  assert.ok(msg.includes("Unsupported agents"));
  assert.ok(msg.includes("claude-code"));
  assert.ok(msg.includes("codex"));
});

test("parseUseOptions: '*' is rejected", () => {
  const { errors } = parseUseOptions(["owner/repo", "--agent", "*"]);
  assert.ok(errors.some((e) => e.includes("does not support '*'")));
});

test("parseUseOptions: --agent without a value errors", () => {
  const { errors } = parseUseOptions(["owner/repo", "--agent"]);
  assert.ok(errors.some((e) => e.includes("requires an agent name")));
});

test("parseUseOptions: boolean flags and unknown options", () => {
  const ok = parseUseOptions(["owner/repo", "--full-depth", "--dangerously-accept-openclaw-risks", "-h"]);
  assert.equal(ok.options.fullDepth, true);
  assert.equal(ok.options.dangerouslyAcceptOpenclawRisks, true);
  assert.equal(ok.options.help, true);

  const bad = parseUseOptions(["owner/repo", "--nope"]);
  assert.ok(bad.errors.some((e) => e.includes("Unknown option: --nope")));
});

// ---- buildUsePrompt ----

test("buildUsePrompt: omits the supporting-files section when there are none", () => {
  const prompt = buildUsePrompt({ skillMd: "# Skill", hasSupportingFiles: false });
  assert.ok(prompt.includes("<SKILL.md>\n# Skill\n</SKILL.md>"));
  assert.ok(!prompt.includes("Supporting files"));
});

test("buildUsePrompt: includes supportDir when supporting files exist", () => {
  const prompt = buildUsePrompt({
    skillMd: "# Skill",
    supportDir: "/tmp/skills-use-xyz/foo",
    hasSupportingFiles: true,
  });
  assert.ok(prompt.includes("Supporting files"));
  assert.ok(prompt.includes("/tmp/skills-use-xyz/foo"));
});

// ---- materializeUseSkill (disk) ----

test("materializeUseSkill: copies files and detects supporting files", async () => {
  const src = tmp("adg-use-src-");
  writeFileSync(join(src, "SKILL.md"), "---\nname: demo\n---\nhi");
  writeFileSync(join(src, "helper.txt"), "support");
  mkdirSync(join(src, "sub"));
  writeFileSync(join(src, "sub", "nested.txt"), "nested");

  const skill: UseSkill = { kind: "disk", name: "demo", directoryName: "demo", path: src };
  const result = await materializeUseSkill(skill);

  assert.ok(existsSync(join(result.skillDir, "SKILL.md")));
  assert.ok(existsSync(join(result.skillDir, "helper.txt")));
  assert.ok(existsSync(join(result.skillDir, "sub", "nested.txt")));
  assert.equal(result.hasSupportingFiles, true);
  assert.ok(result.skillMd.includes("hi"));
});

test("materializeUseSkill: a SKILL.md-only skill has no supporting files", async () => {
  const src = tmp("adg-use-src-");
  writeFileSync(join(src, "SKILL.md"), "# only");

  const result = await materializeUseSkill({ kind: "disk", name: "x", directoryName: "x", path: src });
  assert.equal(result.hasSupportingFiles, false);
});

test("materializeUseSkill: refuses symlinks pointing outside the skill", async () => {
  const secretDir = tmp("adg-use-secret-");
  const secret = join(secretDir, "id_rsa");
  writeFileSync(secret, "PRIVATE KEY");

  const src = tmp("adg-use-src-");
  writeFileSync(join(src, "SKILL.md"), "# s");
  writeFileSync(join(src, "inside.txt"), "ok");
  symlinkSync(secret, join(src, "leak"));            // escapes the skill root
  symlinkSync(join(src, "inside.txt"), join(src, "alias")); // stays inside
  symlinkSync(join(src, "missing.txt"), join(src, "broken")); // dangling

  const result = await materializeUseSkill({ kind: "disk", name: "s", directoryName: "s", path: src });

  assert.ok(!existsSync(join(result.skillDir, "leak")), "outside symlink must not be materialized");
  assert.ok(!existsSync(join(result.skillDir, "broken")), "broken symlink must be skipped");
  assert.ok(existsSync(join(result.skillDir, "alias")), "inside symlink should be copied");
  assert.equal(readFileSync(join(result.skillDir, "alias"), "utf-8"), "ok");
});

test("materializeUseSkill (blob): drops path-traversal entries", async () => {
  const skill: UseSkill = {
    kind: "blob",
    name: "b",
    directoryName: "b",
    rawContent: "# b",
    files: [
      { path: "SKILL.md", contents: "# b" },
      { path: "../escape.txt", contents: "nope" },
    ],
  };
  const result = await materializeUseSkill(skill);
  assert.ok(existsSync(join(result.skillDir, "SKILL.md")));
  assert.ok(!existsSync(join(result.tempRoot, "escape.txt")), "traversal write must be dropped");
});

// ---- launchAgentInteractively ----

function fakeSpawn(behavior: { code?: number | null; error?: NodeJS.ErrnoException }): {
  spawn: AgentSpawn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: AgentSpawn = (command, args) => {
    calls.push({ command, args });
    const listeners: Record<string, Array<(...a: any[]) => void>> = { error: [], close: [] };
    const proc: AgentProcess = {
      on(event, listener) {
        listeners[event]!.push(listener);
        return proc;
      },
    };
    setImmediate(() => {
      if (behavior.error) listeners.error!.forEach((l) => l(behavior.error));
      else listeners.close!.forEach((l) => l("code" in behavior ? behavior.code : 0));
    });
    return proc;
  };
  return { spawn, calls };
}

test("launchAgentInteractively: passes the prompt as an argv to the mapped command", async () => {
  const fake = fakeSpawn({ code: 0 });
  const exit = await launchAgentInteractively("claude-code", "PROMPT", fake.spawn);
  assert.equal(exit, 0);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "claude");
  assert.deepEqual(fake.calls[0]!.args, ["PROMPT"]);
});

test("launchAgentInteractively: propagates a non-zero exit code", async () => {
  const fake = fakeSpawn({ code: 3 });
  assert.equal(await launchAgentInteractively("codex", "p", fake.spawn), 3);
});

test("launchAgentInteractively: a null close code maps to 1", async () => {
  const fake = fakeSpawn({ code: null });
  assert.equal(await launchAgentInteractively("claude-code", "p", fake.spawn), 1);
});

test("launchAgentInteractively: ENOENT becomes a friendly 'command not found'", async () => {
  const err: NodeJS.ErrnoException = new Error("spawn claude ENOENT");
  err.code = "ENOENT";
  const fake = fakeSpawn({ error: err });
  await assert.rejects(launchAgentInteractively("claude-code", "p", fake.spawn), /command not found: claude/);
});

test("launchAgentInteractively: other spawn errors propagate unchanged", async () => {
  const err: NodeJS.ErrnoException = new Error("boom");
  err.code = "EACCES";
  const fake = fakeSpawn({ error: err });
  await assert.rejects(launchAgentInteractively("codex", "p", fake.spawn), (e) => e === err);
});

test("launchAgentInteractively: an unsupported agent rejects before spawning", async () => {
  const fake = fakeSpawn({ code: 0 });
  await assert.rejects(
    launchAgentInteractively("cursor" as any, "p", fake.spawn),
    /not supported yet/
  );
  assert.equal(fake.calls.length, 0);
});
