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
  try {
    await Promise.all(Array.from({ length: 12 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
        env: { ...process.env, ADG_MUTEX_HOME: mutex }, stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk) => { diagnostic += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(diagnostic)));
    })));
    assert.deepEqual(readdirSync(mutex), []);
    assert.equal(existsSync(join(root, "active")), false);
    const previous = process.env.ADG_MUTEX_HOME;
    process.env.ADG_MUTEX_HOME = mutex;
    try { await withStoreMutex(root, () => undefined); }
    finally {
      if (previous === undefined) delete process.env.ADG_MUTEX_HOME;
      else process.env.ADG_MUTEX_HOME = previous;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
