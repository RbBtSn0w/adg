import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { SpawnSyncReturns } from "node:child_process";

import { annotateCliRun, makeCli, skippedResult } from "../src/agents/base.ts";

// `node` is guaranteed present in the test environment, so it stands in for a
// real agent CLI; a deliberately absent name exercises the launch-failure path.
const MISSING = "adg-nonexistent-binary-zzz";

function makeSpan() {
  const attrs: Record<string, unknown> = {};
  const exceptions: Error[] = [];
  const statuses: Array<{ code: SpanStatusCode; message?: string }> = [];
  const span: Pick<Span, "setAttribute" | "recordException" | "setStatus"> = {
    setAttribute: (name: string, value: unknown) => {
      attrs[name] = value;
      return span as Span;
    },
    recordException: (exception: Error) => {
      exceptions.push(exception);
    },
    setStatus: (status) => {
      statuses.push(status);
      return span as Span;
    },
  };
  return { span, attrs, exceptions, statuses };
}

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

test("annotateCliRun records low-cardinality status only for non-zero exits", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const r = {
    output: [],
    pid: 123,
    status: 1,
    signal: null,
    stdout: "",
    stderr: "merge conflict while updating marketplace",
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "marketplace", "update", "adg"], r);

  assert.equal(attrs["process.pid"], 123);
  assert.equal(attrs["process.exit.code"], 1);
  assert.equal(attrs["error.type"], "EXIT_CODE_1");
  assert.equal(attrs["exception.slug"], undefined);
  assert.equal(attrs["cli.stderr_excerpt"], undefined);
  assert.equal(exceptions.length, 0);
  assert.equal(statuses[0]!.code, SpanStatusCode.ERROR);
  assert.equal(statuses[0]!.message, "CLI process exited with status 1");
});

test("annotateCliRun never exports stdout or stderr excerpts", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const r = {
    output: [],
    pid: 321,
    status: 1,
    signal: null,
    stdout: "printed to stdout",
    stderr: "",
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "list"], r);

  assert.equal(attrs["cli.stdout_excerpt"], undefined);
  assert.equal(attrs["cli.stderr_excerpt"], undefined);
  assert.equal(exceptions.length, 0);
  assert.equal(statuses[0]!.code, SpanStatusCode.ERROR);
});

test("annotateCliRun omits credentials and all other failure details", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const r = {
    output: [],
    pid: 322,
    status: 1,
    signal: null,
    stdout: "",
    stderr: "request failed with github_pat_11AA22BB33CC44DD55EE66FF77GG88HH99II00JJ and Authorization: Bearer secret-value",
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "list"], r);

  assert.equal(attrs["cli.stderr_excerpt"], undefined);
  assert.equal(exceptions.length, 0);
  assert.doesNotMatch(statuses[0]!.message ?? "", /github_pat_|secret-value/);
});

test("annotateCliRun records signal-terminated processes as failures", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const r = {
    output: [],
    pid: 654,
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "terminated",
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "list"], r);

  assert.equal(attrs["process.pid"], 654);
  assert.equal(attrs["process.exit.code"], -1);
  assert.equal(attrs["process.exit.signal"], "SIGTERM");
  assert.equal(attrs["error.type"], "SIGNAL_SIGTERM");
  assert.equal(attrs["exception.slug"], undefined);
  assert.equal(attrs["cli.stderr_excerpt"], undefined);
  assert.equal(exceptions.length, 0);
  assert.equal(statuses[0]!.code, SpanStatusCode.ERROR);
});

test("annotateCliRun classifies spawn failures without exporting raw details", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const spawnError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const r = {
    output: [],
    pid: 456,
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: spawnError,
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "list"], r);

  assert.equal(attrs["process.pid"], 456);
  assert.equal(attrs["process.exit.code"], -1);
  assert.equal(attrs["error.type"], "ENOENT");
  assert.equal(attrs["exception.slug"], undefined);
  assert.equal(exceptions.length, 0);
  assert.equal(statuses[0]!.code, SpanStatusCode.ERROR);
  assert.equal(statuses[0]!.message, "CLI process failed to start");
});

test("annotateCliRun leaves successful exits as success metadata only", () => {
  const { span, attrs, exceptions, statuses } = makeSpan();
  const r = {
    output: [],
    pid: 789,
    status: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
  } as unknown as SpawnSyncReturns<string>;

  annotateCliRun(span, "claude", ["plugin", "list"], r);

  assert.equal(attrs["process.pid"], 789);
  assert.equal(attrs["process.exit.code"], 0);
  assert.equal(attrs["error.type"], undefined);
  assert.equal(attrs["exception.slug"], undefined);
  assert.equal(exceptions.length, 0);
  assert.equal(statuses.length, 0);
});
