import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunResult } from "../src/agents/base.ts";
import { syncMarketplace } from "../src/agents/codex.ts";

function result(ok: boolean, out = ""): RunResult {
  return { ok, out };
}

test("syncMarketplace falls back to upgrade when add fails", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "add") return result(false, "add failed");
    if (args[2] === "upgrade") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg-12345678", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "add", "/tmp/plugins"],
    ["plugin", "marketplace", "upgrade", "adg-12345678"],
  ]);
});

test("syncMarketplace warns when Codex add and upgrade both fail", () => {
  const warnings: string[] = [];
  const runner = (args: string[]): RunResult => {
    if (args[2] === "add") return result(false, "add failed");
    if (args[2] === "upgrade") return result(false, "upgrade failed");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg-12345678", runner, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /failed to sync Codex marketplace/i);
  assert.match(warnings[0]!, /upgrade failed/);
});
