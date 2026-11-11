import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "../src/store-mutex.ts")).href;

function exercise(platform: string, code: string, release: boolean, malformed = false, recovery: "none" | "ticket" | "metadata" = "none"): void {
  // Isolate builtin mocks and the platform boundary from every other test.
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = fs.mkdtempSync(join(tmpdir(), 'adg-ticket-boundary-'));
    const contender = join(root, process.pid + '-00000000-0000-0000-0000-000000000000');
    fs.mkdirSync(contender);
    const ticket = join(contender, 'ticket.json');
    fs.writeFileSync(ticket, ${JSON.stringify(malformed ? 'null' : recovery === 'none' ? '1' : '100')});
    const original = { read: fs.readFileSync, stat: fs.lstatSync, exists: fs.existsSync };
    let observations = 0;
    let reads = 0;
    let entered = false;
    fs.readFileSync = function(path, ...args) {
      if (path === ticket && !${malformed}) {
        reads++;
        if (${recovery !== "none"} && reads >= 4) {
          fs.unlinkSync(ticket); fs.rmdirSync(contender);
          throw Object.assign(new Error('Contender released'), { code: 'ENOENT' });
        }
        if (${recovery === "none"} || reads === 1) throw Object.assign(new Error('Transient ticket access'), { code: ${JSON.stringify(recovery === "metadata" ? "ENOENT" : code)} });
      }
      return original.read.call(this, path, ...args);
    };
    fs.existsSync = function(path) { return path === contender ? false : original.exists.call(this, path); };
    fs.lstatSync = function(path, ...args) {
      if (path === contender) {
        observations++;
        if (${release && recovery === "none"} && observations >= 3) {
          fs.unlinkSync(ticket); fs.rmdirSync(contender);
          throw Object.assign(new Error('Contender released'), { code: 'ENOENT' });
        }
        if (observations === 1) throw Object.assign(new Error('Presence temporarily unreadable'), { code: ${JSON.stringify(code)} });
      }
      const stat = original.stat.call(this, path, ...args);
      // Keep the injected POSIX permission boundary independent of the host OS.
      if (path === root) stat.mode = (stat.mode & ~0o777) | 0o700;
      return stat;
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    process.env.ADG_MUTEX_HOME = root;
    try {
      const { withStoreMutex } = await import(${JSON.stringify(moduleUrl)});
      const run = () => withStoreMutex('unused', () => {
        entered = true;
        if (${recovery === "none"}) assert.ok(observations >= 3, 'Unreadable live contender must block entry');
        else {
          assert.ok(reads >= 4, 'Recovered ticket must still block while holder is active');
          const own = fs.readdirSync(root).find(name => name !== contender.split(/[\\/]/).at(-1));
          assert.equal(JSON.parse(original.read(join(root, own, 'ticket.json'), 'utf8')), 101, 'New ticket must follow the recovered holder');
        }
        assert.equal(original.exists(contender), false, 'Only proven absence releases the contender');
      }, ${release ? 1000 : 75});
      if (${malformed}) await assert.rejects(run, /Invalid ADG mutation ticket/);
      else if (${JSON.stringify(platform)} !== 'win32') await assert.rejects(run, { code: ${JSON.stringify(code)} });
      else if (!${release}) await assert.rejects(run, /Another ADG mutation is still running/);
      else { await run(); assert.equal(entered, true); }
      if (!${release} || ${malformed} || ${JSON.stringify(platform)} !== 'win32') assert.equal(entered, false);
    } finally {
      fs.readFileSync = original.read; fs.lstatSync = original.stat; fs.existsSync = original.exists;
      syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

for (const code of ["EPERM", "EACCES"]) {
  test(`Windows ${code} ticket race blocks until the contender is demonstrably absent`, () => exercise("win32", code, true));
  test(`Windows ${code} live contender retains the bounded timeout`, () => exercise("win32", code, false));
  test(`POSIX ${code} ticket failures remain errors`, () => exercise("darwin", code, false));
}

test("Windows malformed tickets remain hard failures", () => exercise("win32", "EPERM", false, true));

for (const code of ["EPERM", "EACCES"]) {
  test(`Windows recovered ${code} holder keeps its ticket priority`, () => exercise("win32", code, true, false, "ticket"));
}

test("Windows uncertain metadata cannot hide an already published ticket", () => exercise("win32", "EPERM", true, false, "metadata"));
