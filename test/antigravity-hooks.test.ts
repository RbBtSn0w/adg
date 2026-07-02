import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAntigravityRoot } from "../src/agents/antigravity.ts";
import { writeAntigravityHooks } from "../src/adapters/antigravity-hooks.ts";
import { readManifest } from "../src/manifest.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";

const fixture = join(import.meta.dirname, "fixtures", "superpowers");

function writeManifest(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", ".plugin.json"),
    JSON.stringify({
      schemaVersion: ADG_SCHEMA_VERSION,
      name: "superpowers",
      version: "1.0.0",
      description: "Superpowers hook fixture",
      hooks: "./hooks/",
      ...extra,
    }),
  );
}

function makeSuperpowersPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  writeManifest(dir, { skills: "./skills/" });
  cpSync(join(fixture, "hooks"), join(dir, "hooks"), { recursive: true });
  cpSync(join(fixture, "skills"), join(dir, "skills"), { recursive: true });
  chmodSync(join(dir, "hooks", "run-hook.cmd"), 0o755);
  chmodSync(join(dir, "hooks", "session-start"), 0o755);
  return dir;
}

test("Antigravity projects Claude SessionStart without modifying the canonical hook", () => {
  const dir = makeSuperpowersPlugin();
  try {
    const canonicalPath = join(dir, "hooks", "hooks.json");
    const canonicalBefore = readFileSync(canonicalPath, "utf8");

    ensureAntigravityRoot(dir);

    assert.equal(readFileSync(canonicalPath, "utf8"), canonicalBefore);
    const rootHooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as {
      superpowers: { PreInvocation: Array<{ type: string; command: string; timeout: number }> };
    };
    assert.equal("hooks" in rootHooks, false, "Antigravity has no Claude top-level hooks wrapper");
    assert.deepEqual(Object.keys(rootHooks), ["superpowers"]);
    assert.deepEqual(Object.keys(rootHooks.superpowers), ["PreInvocation"]);
    assert.equal(rootHooks.superpowers.PreInvocation[0]?.type, "command");
    assert.equal(rootHooks.superpowers.PreInvocation[0]?.timeout, 30);
    assert.match(rootHooks.superpowers.PreInvocation[0]?.command ?? "", /\.antigravity-plugin\/hook-runner\.mjs/);
    assert.ok(rootHooks.superpowers.PreInvocation[0]?.command.includes(dir), "runner path must not depend on Antigravity cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity runner converts Superpowers context on the first invocation only", () => {
  const dir = makeSuperpowersPlugin();
  try {
    ensureAntigravityRoot(dir);
    const rootHooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as {
      superpowers: { PreInvocation: Array<{ command: string }> };
    };
    const command = rootHooks.superpowers.PreInvocation[0]!.command;

    const first = spawnSync(command, {
      cwd: dir,
      shell: true,
      encoding: "utf8",
      input: JSON.stringify({ invocationNum: 0, initialNumSteps: 1 }),
    });
    assert.equal(first.status, 0, first.stderr);
    const output = JSON.parse(first.stdout) as { injectSteps: Array<{ ephemeralMessage: string }> };
    assert.match(output.injectSteps[0]?.ephemeralMessage ?? "", /You have superpowers/);

    const later = spawnSync(command, {
      cwd: dir,
      shell: true,
      encoding: "utf8",
      input: JSON.stringify({ invocationNum: 1, initialNumSteps: 1 }),
    });
    assert.equal(later.status, 0, later.stderr);
    assert.deepEqual(JSON.parse(later.stdout), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity maps common events, tool names, and reports unsupported Claude events", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  try {
    writeManifest(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const handler = { type: "command", command: "printf '{}'" };
    writeFileSync(
      join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "startup|clear", hooks: [handler] }],
          PreToolUse: [{ matcher: "Bash|Read", hooks: [handler] }],
          PostToolUse: [{ matcher: "Bash", hooks: [handler] }],
          Stop: [{ hooks: [handler] }],
          UserPromptExpansion: [{ hooks: [handler] }],
        },
      }),
    );

    const warnings = writeAntigravityHooks(dir, readManifest(dir));

    assert.ok(warnings.some((warning) => warning.includes('event "UserPromptExpansion"')));
    const rootHooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as {
      superpowers: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(rootHooks.superpowers), ["PreInvocation", "PreToolUse", "PostToolUse", "Stop"]);
    const pre = rootHooks.superpowers.PreToolUse as Array<{ matcher: string }>;
    const post = rootHooks.superpowers.PostToolUse as Array<{ matcher: string }>;
    assert.equal(pre[0]?.matcher, "run_command|view_file");
    assert.equal(post[0]?.matcher, "run_command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity runner preserves safe control semantics for tool and stop events", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  try {
    writeManifest(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(
      join(dir, "hooks", "runtime.mjs"),
      `import { readFileSync } from "node:fs";
const mode = process.argv[2];
const input = JSON.parse(readFileSync(0, "utf8"));
if (mode === "pre") {
  if (input.tool_name !== "Bash") process.exit(3);
  process.stdout.write(JSON.stringify({ continue: false, stopReason: "policy stop" }));
} else if (mode === "pre-pass") {
  process.stdout.write("{}");
} else if (mode === "post") {
  process.stdout.write(JSON.stringify({ decision: "block", reason: "retry with fixes" }));
} else if (mode === "stop") {
  process.stdout.write(JSON.stringify({ decision: "block", reason: "continue working" }));
}
`,
    );
    const command = (mode: string) => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/runtime.mjs" ${mode}`;
    writeFileSync(
      join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: command("pre") }] }],
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: command("post") }] }],
          Stop: [{ hooks: [{ type: "command", command: command("stop") }] }],
        },
      }),
    );
    writeAntigravityHooks(dir, readManifest(dir));
    const projected = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as {
      superpowers: {
        PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
        Stop: Array<{ command: string }>;
      };
    };
    const run = (hookCommand: string, input: unknown) => spawnSync(hookCommand, {
      cwd: "/tmp",
      shell: true,
      encoding: "utf8",
      input: JSON.stringify(input),
    });

    const pre = run(projected.superpowers.PreToolUse[0]!.hooks[0]!.command, {
      toolCall: { name: "run_command", args: { CommandLine: "rm -rf build" } },
      stepIdx: 1,
    });
    assert.equal(pre.status, 0, pre.stderr);
    assert.deepEqual(JSON.parse(pre.stdout), { decision: "deny", reason: "policy stop" });

    const prePassCommand = projected.superpowers.PreToolUse[0]!.hooks[0]!.command.replace(
      Buffer.from(command("pre"), "utf8").toString("base64url"),
      Buffer.from(command("pre-pass"), "utf8").toString("base64url"),
    );
    const prePass = run(prePassCommand, { toolCall: { name: "run_command", args: {} }, stepIdx: 1 });
    assert.equal(prePass.status, 0, prePass.stderr);
    assert.deepEqual(JSON.parse(prePass.stdout), { decision: "allow" });

    const post = run(projected.superpowers.PostToolUse[0]!.hooks[0]!.command, { stepIdx: 1 });
    assert.equal(post.status, 1);
    assert.match(post.stderr, /PostToolUse block output has no safe Antigravity mapping/);

    const stop = run(projected.superpowers.Stop[0]!.command, { executionNum: 1, fullyIdle: true });
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), { decision: "continue", reason: "continue working" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity keeps the last-known-good projection when canonical hooks are invalid", () => {
  const dir = makeSuperpowersPlugin();
  try {
    writeAntigravityHooks(dir, readManifest(dir));
    const target = join(dir, "hooks.json");
    const runner = join(dir, ".antigravity-plugin", "hook-runner.mjs");
    const targetBefore = readFileSync(target, "utf8");
    const runnerBefore = readFileSync(runner, "utf8");
    writeFileSync(join(dir, "hooks", "hooks.json"), "{broken");

    assert.throws(() => writeAntigravityHooks(dir, readManifest(dir)), /invalid canonical hooks JSON/);
    assert.equal(readFileSync(target, "utf8"), targetBefore);
    assert.equal(readFileSync(runner, "utf8"), runnerBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity rejects an invalid native override without replacing the working projection", () => {
  const dir = makeSuperpowersPlugin();
  try {
    writeAntigravityHooks(dir, readManifest(dir));
    const target = join(dir, "hooks.json");
    const targetBefore = readFileSync(target, "utf8");
    writeFileSync(join(dir, "hooks", "hooks-antigravity.json"), "{broken");

    assert.throws(() => writeAntigravityHooks(dir, readManifest(dir)), /invalid native Antigravity hooks JSON/);
    assert.equal(readFileSync(target, "utf8"), targetBefore);

    writeFileSync(
      join(dir, "hooks", "hooks-antigravity.json"),
      JSON.stringify({ reminder: { PreInvocation: { command: "./hooks/native.sh" } } }),
    );
    assert.throws(() => writeAntigravityHooks(dir, readManifest(dir)), /invalid native Antigravity hooks schema/);
    assert.equal(readFileSync(target, "utf8"), targetBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity warns and omits unknown tool matchers instead of assuming name parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  try {
    writeManifest(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(
      join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "CustomTool", hooks: [{ type: "command", command: "printf '{}'" }] }],
        },
      }),
    );

    const warnings = writeAntigravityHooks(dir, readManifest(dir));

    assert.ok(warnings.some((warning) => warning.includes('matcher "CustomTool" cannot be safely mapped')));
    assert.equal(existsSync(join(dir, "hooks.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity maps Claude MCP tool matchers correctly to Antigravity format", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  try {
    writeManifest(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(
      join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__.*__run_query",
              hooks: [{ type: "command", command: "printf '{}'" }],
            },
          ],
          PostToolUse: [
            {
              matcher: "mcp__.*__find_columns|mcp__.*__get_dataset_columns|mcp__.*__get_dataset",
              hooks: [{ type: "command", command: "printf '{}'" }],
            },
          ],
        },
      }),
    );

    const warnings = writeAntigravityHooks(dir, readManifest(dir));

    assert.equal(warnings.length, 0);
    assert.ok(existsSync(join(dir, "hooks.json")));
    const generated = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"));
    const pluginHooks = generated.superpowers;
    assert.equal(pluginHooks.PreToolUse[0].matcher, "mcp_.*_run_query");
    assert.equal(
      pluginHooks.PostToolUse[0].matcher,
      "mcp_.*_find_columns|mcp_.*_get_dataset_columns|mcp_.*_get_dataset"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Antigravity rejects an mcp__ matcher that maps to an invalid regex", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-agy-hooks-"));
  try {
    writeManifest(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(
      join(dir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__[__run_query",
              hooks: [{ type: "command", command: "printf '{}'" }],
            },
          ],
        },
      }),
    );

    const warnings = writeAntigravityHooks(dir, readManifest(dir));

    assert.ok(warnings.some((warning) => warning.includes('matcher "mcp__[__run_query" cannot be safely mapped')));
    assert.equal(existsSync(join(dir, "hooks.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity prefers a native override and removes generated hooks when deselected", () => {
  const dir = makeSuperpowersPlugin();
  try {
    const native = {
      reminder: { PreInvocation: [{ type: "command", command: "./hooks/native.sh" }] },
    };
    writeFileSync(join(dir, "hooks", "hooks-antigravity.json"), JSON.stringify(native));

    ensureAntigravityRoot(dir);

    assert.deepEqual(JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")), native);
    assert.equal(existsSync(join(dir, ".antigravity-plugin", "hook-runner.mjs")), false);

    ensureAntigravityRoot(dir, { components: ["skills"], skills: ["using-superpowers"] });
    assert.equal(existsSync(join(dir, "hooks.json")), false);
    assert.equal(existsSync(join(dir, ".antigravity-plugin", "hook-runner.mjs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
