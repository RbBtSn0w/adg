import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SpanKind, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { writeSkillLock } from "../vendor/skills/src/skill-lock.ts";
import { updateGlobalSkills, updateProjectSkills, resolveSelfCliEntry } from "../vendor/skills/src/update.ts";
import { tmp } from "./helpers.ts";

const hash = "a".repeat(40);
const entry = {
  source: "fixture/repo",
  sourceType: "github",
  sourceUrl: "https://github.com/fixture/repo.git",
  skillPath: "skills/fixture/SKILL.md",
  skillFolderHash: hash,
  installedAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};

async function withGlobalLock(run: (dir: string) => Promise<void>) {
  const dir = tmp();
  const previousState = process.env.XDG_STATE_HOME;
  const previousFetch = globalThis.fetch;
  try {
    process.env.XDG_STATE_HOME = dir;
    globalThis.fetch = async () => new Response(JSON.stringify({ sha: hash, tree: [
      { path: "skills/fixture", type: "tree", sha: hash },
      { path: "skills/fixture/SKILL.md", type: "blob", sha: hash },
    ] }), { status: 200 });
    await writeSkillLock({ version: 3, skills: { fixture: entry } });
    await run(dir);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const isTTY of [false, true]) {
  test(`global update progress preserves the historical TTY contract (${isTTY})`, async () => {
    const output: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writer = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      const text = String(chunk);
      if (text.startsWith("\r") || text.startsWith("Checking skills from source:")) {
        output.push(text);
        return true;
      }
      return originalWrite(chunk);
    });
    const logger = mock.method(console, "log", () => {});
    try {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
      await withGlobalLock(async () => {
        assert.equal((await updateGlobalSkills({ yes: true })).failCount, 0);
      });
      const status = output.find((line) => line.includes("Checking skills from source"))!;
      assert.ok(status);
      if (isTTY) {
        assert.ok(status.startsWith("\r"));
        assert.ok(!status.endsWith("\n"));
        assert.ok(output.includes("\r\x1b[K"));
      } else {
        assert.equal(status, "Checking skills from source: fixture/repo\n");
        assert.ok(output.every((line) => !line.includes("\x1b[K")));
      }
    } finally {
      writer.mock.restore();
      logger.mock.restore();
      if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });
}

test("global updates report failed sources even when another skill updates successfully", async () => {
  const spawn = mock.method(childProcess, "spawnSync", () => ({
    pid: 42, status: 0, signal: null, output: [null, "", ""], stdout: "", stderr: "",
  }));
  const logger = mock.method(console, "log", () => {});
  syncBuiltinESMExports();
  try {
    await withGlobalLock(async (dir) => {
      await writeSkillLock({ version: 3, skills: {
        fixture: { ...entry, skillFolderHash: "b".repeat(40) },
        unavailable: { ...entry, source: "missing", sourceType: "git",
          sourceUrl: pathToFileURL(join(dir, "does-not-exist")).href },
      } });
      const result = await updateGlobalSkills({ yes: true });
      assert.equal(result.successCount, 1);
      assert.equal(result.failCount, 1);
    });
  } finally {
    spawn.mock.restore();
    logger.mock.restore();
    syncBuiltinESMExports();
  }
});

test("missing update entrypoints retain the historical failure span", async () => {
  const project = tmp();
  const previousCwd = process.cwd();
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const cli = resolveSelfCliEntry();
  const exists = fs.existsSync;
  const existence = mock.method(fs, "existsSync", (path: fs.PathLike) => path === cli ? false : exists(path));
  const logger = mock.method(console, "log", () => {});
  syncBuiltinESMExports();
  try {
    process.chdir(project);
    fs.writeFileSync(join(project, "skills-lock.json"), JSON.stringify({ version: 1, skills: {
      fixture: { source: "fixture/repo", sourceType: "github", computedHash: hash,
        skillPath: "skills/fixture/SKILL.md" },
    } }));
    assert.equal((await updateProjectSkills({ yes: true })).failCount, 1);
    const span = exporter.getFinishedSpans().find((span) => span.attributes["error.type"] === "CLI_ENTRYPOINT_NOT_FOUND");
    assert.ok(span);
    assert.equal(span.kind, SpanKind.CLIENT);
    assert.equal(span.attributes["process.exit.code"], -1);
    assert.ok(!JSON.stringify(span.attributes).includes(project));
  } finally {
    process.chdir(previousCwd);
    existence.mock.restore();
    logger.mock.restore();
    syncBuiltinESMExports();
    trace.disable();
    await provider.shutdown();
    fs.rmSync(project, { recursive: true, force: true });
  }
});
