import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunResult } from "../src/agents/base.ts";
import { syncMarketplace } from "../src/agents/claude.ts";

function result(ok: boolean, out = ""): RunResult {
  return { ok, out };
}

test("syncMarketplace falls back to add when marketplace update fails", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(false, "update failed");
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace only adds when the marketplace is not listed", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "other" }]));
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace does not add when the marketplace update succeeds", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
  ]);
});
