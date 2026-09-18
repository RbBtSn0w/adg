import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneAgents, pruneHasErrors } from "../src/commands/prune.ts";
import type { Agent, AgentPruneResult } from "../src/agents/types.ts";

function fakeAgent(id: string, pruneStale?: () => AgentPruneResult): Agent {
  return {
    id,
    displayName: id,
    adaptTarget: "claude",
    detect: () => true,
    available: () => true,
    activate: () => ({ agent: id, affected: [], skipped: false }),
    deactivate: () => ({ agent: id, affected: [], skipped: false }),
    refresh: () => ({ agent: id, affected: [], skipped: false }),
    ...(pruneStale ? { pruneStale } : {}),
  };
}

test("pruneAgents calls pruneStale on every agent that implements it", () => {
  const claude = fakeAgent("claude", () => ({ agent: "claude", skipped: false, removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }], errors: [] }));
  const antigravity = fakeAgent("antigravity"); // no pruneStale — nothing analogous to prune

  const results = pruneAgents({ agents: [claude, antigravity] });

  assert.deepEqual(results, [
    { agent: "claude", skipped: false, removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }], errors: [] },
    { agent: "antigravity", skipped: true, removed: [], errors: [] },
  ]);
});

test("pruneAgents propagates errors without throwing", () => {
  const codex = fakeAgent("codex", () => ({ agent: "codex", skipped: false, removed: [], errors: ["codex plugin marketplace list failed"] }));

  const [result] = pruneAgents({ agents: [codex] });

  assert.equal(result!.errors.length, 1);
  assert.deepEqual(result!.removed, []);
});

test("pruneHasErrors is false when nothing failed, including a mix of skipped/removed/clean agents", () => {
  const results: AgentPruneResult[] = [
    { agent: "claude", skipped: false, removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }], errors: [] },
    { agent: "codex", skipped: false, removed: [], errors: [] },
    { agent: "antigravity", skipped: true, removed: [], errors: [] },
  ];
  assert.equal(pruneHasErrors(results), false);
});

test("pruneHasErrors is true when any single agent reported an error", () => {
  const results: AgentPruneResult[] = [
    { agent: "claude", skipped: false, removed: [], errors: [] },
    { agent: "codex", skipped: false, removed: [], errors: ["failed to remove stale Codex marketplace \"adg-deadbeef\": permission denied"] },
  ];
  assert.equal(pruneHasErrors(results), true);
});
