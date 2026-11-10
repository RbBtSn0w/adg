import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("skills add installs a hosted SKILL.md download without cloning", async () => {
  const project = await mkdtemp(join(tmpdir(), "adg-direct-download-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DISABLE_TELEMETRY: "1",
      CLAUDE_CONFIG_DIR: join(project, "claude-home"),
      CODEX_HOME: join(project, "codex-home"),
      GEMINI_HOME: join(project, "gemini-home"),
    };
    delete env.NODE_TEST_CONTEXT;
    await Promise.all(
      ["claude-home", "codex-home", "gemini-home"].map((name) => mkdir(join(project, name))),
    );
    const fixture = fileURLToPath(
      new URL("./fixtures/skills-direct-download-child.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, [fixture], {
      cwd: project,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Installation complete/);

    const installed = await readFile(
      join(project, ".agents", "skills", "direct-download", "SKILL.md"),
      "utf8",
    );
    assert.match(installed, /# Direct download/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
