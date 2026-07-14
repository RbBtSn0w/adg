import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";

import { annotateSubprocess, type SubprocessSpan } from "../src/subprocess.ts";

/**
 * Test Intent
 * Risk: external process spans omit required CLI semantic-convention attributes.
 * Why Automation: parent CLI spans cannot prove subprocess exit/error attribution.
 * Why Existing Tests Insufficient: only agent and git wrappers had local instrumentation tests.
 * Chosen Layer: Unit Test - verify the shared result-to-span transformation.
 * Fragility Analysis: use the minimal Span surface and observable semantic attributes.
 * If Omitted: new wrappers can silently regress required process telemetry.
 */
function fakeSpan() {
  const attributes = new Map<string, unknown>();
  const exceptions: unknown[] = [];
  const statuses: unknown[] = [];
  return {
    attributes,
    exceptions,
    statuses,
    span: {
      setAttribute(key: string, value: Parameters<SubprocessSpan["setAttribute"]>[1]) { attributes.set(key, value); return this; },
      recordException(error: unknown) { exceptions.push(error); },
      setStatus(status: unknown) { statuses.push(status); return this; },
    },
  };
}

function result(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 42,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

test("annotateSubprocess records required success attributes", () => {
  const { span, attributes, exceptions } = fakeSpan();
  annotateSubprocess(span, "node", ["script.js", "--json"], result());
  assert.equal(attributes.get("process.executable.name"), "node");
  assert.equal(attributes.get("process.pid"), 42);
  assert.equal(attributes.get("process.exit.code"), 0);
  assert.deepEqual(attributes.get("process.command_args"), ["node", "[VALUE]", "--json"]);
  assert.equal(exceptions.length, 0);
});

test("annotateSubprocess classifies non-zero exits without recording raw arguments", () => {
  const { span, attributes, exceptions, statuses } = fakeSpan();
  annotateSubprocess(span, "npm", ["install", "/private/path"], result({ status: 7 }));
  assert.equal(attributes.get("process.exit.code"), 7);
  assert.equal(attributes.get("error.type"), "EXIT_CODE_7");
  assert.deepEqual(attributes.get("process.command_args"), ["npm", "install", "[VALUE]"]);
  assert.equal(exceptions.length, 1);
  assert.equal(statuses.length, 1);
});

test("annotateSubprocess classifies launch failures", () => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  const { span, attributes, exceptions } = fakeSpan();
  annotateSubprocess(span, "missing-cli", [], result({ status: null, error }));
  assert.equal(attributes.get("process.exit.code"), -1);
  assert.equal(attributes.get("error.type"), "ENOENT");
  assert.equal(exceptions[0], error);
});

test("annotateSubprocess preserves signal termination", () => {
  const { span, attributes, exceptions } = fakeSpan();
  annotateSubprocess(span, "codex", [], result({ status: null, signal: "SIGTERM" }));
  assert.equal(attributes.get("process.exit.code"), -1);
  assert.equal(attributes.get("process.exit.signal"), "SIGTERM");
  assert.equal(attributes.get("error.type"), "SIGNAL_SIGTERM");
  assert.equal(exceptions.length, 1);
});
