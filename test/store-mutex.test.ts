import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withStoreMutex } from "../src/store-mutex.ts";

test("mutex reclaims crashes before ticket publication and never removes a new holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-mutex-race-"));
  const mutex = join(root, "mutex");
  mkdirSync(mutex, { mode: 0o700 });
  // A crash between candidate mkdir and owner/ticket publication is recoverable.
  mkdirSync(join(mutex, "99999999-00000000-0000-0000-0000-000000000000"));
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "../src/store-mutex.ts")).href;
  const program = `
    import { withStoreMutex } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync, rmSync } from 'node:fs';
    await withStoreMutex('unused', async () => {
      writeFileSync(${JSON.stringify(join(root, "active"))}, 'active', {flag:'wx'});
      await new Promise(resolve=>setTimeout(resolve, 15));
      rmSync(${JSON.stringify(join(root, "active"))});
    });
  `;
  interface ChildOutcome { code: number | null; signal: NodeJS.Signals | null; diagnostic: string; error?: Error }
  const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<ChildOutcome> }> = [];
  try {
    for (let index = 0; index < 12; index++) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
        env: { ...process.env, ADG_MUTEX_HOME: mutex }, stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostic = "";
      let spawnError: Error | undefined;
      const closed = new Promise<ChildOutcome>((resolve) => {
        child.stderr.on("data", (chunk) => { diagnostic += chunk; });
        child.once("error", (error) => { spawnError = error; });
        child.once("close", (code, signal) => resolve({ code, signal, diagnostic, ...(spawnError ? { error: spawnError } : {}) }));
      });
      children.push({ child, closed });
    }
    // Wait for all children and their stdio to close before evaluating failures,
    // so cleanup cannot hide an earlier child error behind Windows ENOTEMPTY.
    const outcomes = await Promise.all(children.map(({ closed }) => closed));
    for (const outcome of outcomes) {
      assert.ifError(outcome.error);
      assert.equal(outcome.code, 0, outcome.diagnostic || `Mutex child terminated with ${outcome.signal}`);
    }
    assert.deepEqual(readdirSync(mutex), []);
    assert.equal(existsSync(join(root, "active")), false);
    const previous = process.env.ADG_MUTEX_HOME;
    process.env.ADG_MUTEX_HOME = mutex;
    try { await withStoreMutex(root, () => undefined); }
    finally {
      if (previous === undefined) delete process.env.ADG_MUTEX_HOME;
      else process.env.ADG_MUTEX_HOME = previous;
    }
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map(({ closed }) => closed));
    rmSync(root, { recursive: true, force: true });
  }
});
