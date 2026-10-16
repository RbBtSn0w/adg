import { test } from "node:test";
import assert from "node:assert/strict";

import { commandOutcome, mergeCommandOutcomes, agentCommandOutcome } from "../src/command-outcome.ts";

test("merging mixed scope results produces a partial non-zero outcome", () => {
  const outcome = mergeCommandOutcomes([
    commandOutcome("success"),
    commandOutcome("failure", "dependency"),
  ]);

  assert.deepEqual(outcome, {
    kind: "partial",
    exitCode: 1,
    errorCategory: "dependency",
  });
});

test("cancelled and expected user failures remain structured", () => {
  assert.deepEqual(commandOutcome("cancelled"), { kind: "cancelled", exitCode: 130 });
  assert.deepEqual(commandOutcome("failure", "user"), {
    kind: "failure",
    exitCode: 1,
    errorCategory: "user",
  });
});

test("an existing partial outcome remains partial when merged", () => {
  assert.deepEqual(
    mergeCommandOutcomes([
      commandOutcome("partial", "dependency"),
      commandOutcome("failure", "dependency"),
    ]),
    {
      kind: "partial",
      exitCode: 1,
      errorCategory: "dependency",
    },
  );
  assert.deepEqual(
    mergeCommandOutcomes([commandOutcome("partial", "dependency")]),
    {
      kind: "partial",
      exitCode: 1,
      errorCategory: "dependency",
    },
  );
});

test("executed but unverified registration is partial; no executed work is failure", () => {
  const failures = [{ stage: "verify" as const, errorType: "STATE_UNAVAILABLE", message: "not verified" }];
  assert.deepEqual(agentCommandOutcome({ agent: "codex", affected: ["demo"], verified: [], unverified: ["demo"], skipped: false, failures }), {
    kind: "partial", exitCode: 1, errorCategory: "dependency",
  });
  assert.equal(agentCommandOutcome({ agent: "codex", affected: [], verified: [], skipped: false, failures }).kind, "failure");
  assert.equal(agentCommandOutcome({ agent: "codex", affected: [], skipped: false }).kind, "success");
});
