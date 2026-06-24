import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCli, skippedResult } from "../src/agents/base.ts";

// `node` is guaranteed present in the test environment, so it stands in for a
// real agent CLI; a deliberately absent name exercises the launch-failure path.
const MISSING = "adg-nonexistent-binary-zzz";

test("available() is true when the probe command exits 0", () => {
  const cli = makeCli("node", { probeArgs: ["--version"] });
  assert.equal(cli.available(), true);
});

test("available() is false when the probe command exits non-zero", () => {
  const cli = makeCli("node", { probeArgs: ["-e", "process.exit(1)"] });
  assert.equal(cli.available(), false);
});

test("available() is false when the binary cannot be launched", () => {
  const cli = makeCli(MISSING, { probeArgs: ["--help"] });
  assert.equal(cli.available(), false);
});

// The probe is memoized: a CLI's presence can't change within one `adg` run, so
// repeated guard calls must not re-spawn. Use a probe that records each run to a
// temp file and assert it ran exactly once across several `available()` calls.
test("available() memoizes the probe and only spawns once", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-probe-"));
  const marker = join(dir, "runs");
  try {
    const cli = makeCli("node", {
      probeArgs: ["-e", `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`],
    });
    assert.equal(cli.available(), true);
    assert.equal(cli.available(), true);
    assert.equal(cli.available(), true);
    assert.equal(readFileSync(marker, "utf8"), "x", "probe should have spawned exactly once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skippedResult builds the canonical CLI-absent lifecycle result", () => {
  assert.deepEqual(skippedResult("claude"), { agent: "claude", affected: [], skipped: true });
});

test("run() concatenates stdout and stderr and reports success", () => {
  const cli = makeCli("node", { probeArgs: [] });
  const r = cli.run(["-e", "process.stdout.write('out');process.stderr.write('err')"]);
  assert.equal(r.ok, true);
  assert.equal(r.out, "outerr");
});

test("run() reports a non-zero exit as failure", () => {
  const cli = makeCli("node", { probeArgs: [] });
  assert.equal(cli.run(["-e", "process.exit(2)"]).ok, false);
});

// (Regression: a launch failure leaves status=null and stderr empty, so the
// only diagnostic is `error`; it must surface in `out` and not be swallowed.)
test("run() surfaces a spawn launch failure instead of swallowing it", () => {
  const cli = makeCli(MISSING, { probeArgs: [] });
  const r = cli.run(["whatever"]);
  assert.equal(r.ok, false);
  assert.notEqual(r.out, "");
});

test("run() echoes the launch error message when echoStderr is set", () => {
  const cli = makeCli(MISSING, { probeArgs: [], echoStderr: true });
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    cli.run(["whatever"]);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, new RegExp(MISSING));
});

test("run() stays silent on failure when echoStderr is unset", () => {
  const cli = makeCli(MISSING, { probeArgs: [] });
  const original = console.error;
  let calls = 0;
  console.error = () => void (calls += 1);
  try {
    cli.run(["whatever"]);
  } finally {
    console.error = original;
  }
  assert.equal(calls, 0);
});
