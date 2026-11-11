import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { renderUpdateReport, renderUpdateAgentReport, renderAgentReport } from "../src/render/plugins.ts";
import { updateResultCounts } from "../src/cli/handlers.ts";
import type { PluginUpdateResult, PluginUpdateSourceResult } from "../src/commands/marketplace.ts";
const source: PluginUpdateSourceResult = { source: "example/public", updated: [], unchanged: [], deleted: [], available: [] };
const result = (remote: PluginUpdateSourceResult[]): PluginUpdateResult => ({ remote, local: { results: [], missing: [] }, agents: [] });

test("action required and pending runtime outcomes are incomplete, with in-command recovery", () => {
  for (const outcome of [{ ...source, actionRequired: ["Review seven historical skills"] }, { ...source, pendingRuntime: ["Agent unavailable"] }]) {
    const data = result([outcome]);
    const text = renderUpdateReport(data).join("\n");
    assert.doesNotMatch(text, /up to date|re-synced/);
    assert.match(text, /adg plugins update/);
    assert.deepEqual(updateResultCounts(data), { succeeded: 0, failed: 1 });
  }
});
test("default report summarizes choices while verbose includes exact names", () => {
  const data = result([{ ...source, migrated: ["split"], deleted: ["old-owner"], notRestored: ["design:historic"], available: ["new-unrelated"] }]);
  const normal = renderUpdateReport(data).join("\n");
  assert.match(normal, /source migrated/);
  assert.doesNotMatch(normal, /split/);
  assert.match(normal, /retired plugins: old-owner/);
  assert.match(normal, /not restored by choice \(1\)/);
  assert.doesNotMatch(normal, /design:historic|new-unrelated|removed stale/);
  const verbose = renderUpdateReport(data, { verbose: true }).join("\n");
  assert.match(verbose, /design:historic/);
  assert.match(verbose, /new-unrelated/);
  assert.match(verbose, /update --all.*once.*add <source> --all.*future/);
});
test("unrecognized legacy owners have a single supported update decision path", () => {
  const text = renderUpdateReport(result([{ ...source, missingUpstream: ["legacy"] }])).join("\n");
  assert.match(text, /Run `adg plugins update` with the same scope in a terminal to keep or remove them/);
  assert.doesNotMatch(text, /adg plugins add|adg plugins remove/);
});
test("completed offline recovery has a precise success message", () => {
  const text = renderUpdateReport(result([{ ...source, resumed: true }])).join("\n");
  assert.match(text, /recovery complete/);
  assert.doesNotMatch(text, /up to date \(0\)|migrated resumed/);
});
test("migration outcome leads with restored skill count and hides internal IDs", () => {
  const data = result([{ ...source, migrated: ["internal-v2-v3"], restored: ["design:a", "design:b"], deleted: ["legacy"] }]);
  const normal = renderUpdateReport(data).join("\n");
  assert.match(normal, /source migrated.*restored 2 historical skills/);
  assert.doesNotMatch(normal, /internal-v2-v3|design:a/);
  assert.match(renderUpdateReport(data, { verbose: true }).join("\n"), /internal-v2-v3/);
});
test("multiple untouched sources collapse into a count while one source keeps its inventory count", () => {
  const untouched = Array.from({ length: 9 }, (_, i) => ({ ...source, source: `example/unchanged-${i}`, unchanged: ["one"] }));
  const normal = renderUpdateReport(result([{ ...source, updated: ["changed"] }, ...untouched])).join("\n");
  assert.match(normal, /9 other sources up to date/);
  assert.doesNotMatch(normal, /unchanged-0/);
  assert.match(renderUpdateReport(result([{ ...source, unchanged: Array(10).fill("one") }])).join("\n"), /up to date \(10\)/);
  assert.match(renderUpdateReport(result(untouched), { verbose: true }).join("\n"), /unchanged-0/);
});
test("runtime failures already represented by a pending source count once", () => {
  const data: PluginUpdateResult = { ...result([{ ...source, pendingRuntime: ["native failed"] }]), agents: [{ agent: "codex", affected: [], skipped: false, failures: [{ plugin: "demo", stage: "verify", errorType: "TEST", message: "native failed" }] }] };
  assert.deepEqual(updateResultCounts(data), { succeeded: 0, failed: 1 });
});

test("unverified runtime plugins make an update incomplete and matching diagnostics count once", () => {
  const unverified = { agent: "codex", affected: [], skipped: false, unverified: ["demo", "demo"] };
  assert.deepEqual(updateResultCounts({ ...result([]), agents: [unverified] }), { succeeded: 0, failed: 1 });
  const failure = { plugin: "demo", stage: "verify" as const, errorType: "TEST", message: "native failed" };
  assert.deepEqual(updateResultCounts({ ...result([]), agents: [{ ...unverified, failures: [failure] }] }), { succeeded: 0, failed: 1 });
  assert.deepEqual(updateResultCounts({ ...result([{ ...source, pendingRuntime: [failure.message] }]), agents: [{ ...unverified, failures: [failure] }] }), { succeeded: 0, failed: 1 });
});

test("unmapped plugin choices describe retaining or removing the old plugin", () => {
  const text = stripVTControlCharacters(renderUpdateReport(result([{ ...source, actionRequired: ["Review unmapped:legacy: legacy"] }])).join("\n"));
  assert.match(text, /keep or remove the old plugin/i);
  assert.doesNotMatch(text, /restore historical skills/);
});
test("default native success is consolidated across runtimes; verbose preserves names", () => {
  const agents = ["claude", "codex", "antigravity"].map(agent => ({ agent, affected: ["one", "two"], verified: ["one", "two"], skipped: false }));
  const normal = renderUpdateAgentReport(agents).join("\n");
  assert.equal(normal.split("\n").length, 1);
  assert.match(normal, /runtime synchronized: 2 plugins across Claude.*Codex.*Antigravity/);
  assert.doesNotMatch(normal, /one|two/);
  assert.match(renderUpdateAgentReport(agents, { verbose: true }).join("\n"), /one, two/);
});
test("native update failures retain details and retry the same scoped update command", () => {
  const agents = [{ agent: "codex", affected: [], skipped: false, failures: [{ plugin: "one", stage: "verify" as const, errorType: "TEST", message: "native failed" }] }];
  const normal = renderUpdateAgentReport(agents, { retryCommand: "adg plugins update --global" }).join("\n");
  assert.match(normal, /Codex \/ one: native failed/);
  assert.match(normal, /adg plugins update --global/);
  assert.doesNotMatch(normal, /plugins sync/);
  assert.match(renderUpdateAgentReport(agents, { verbose: true, retryCommand: "adg plugins update --global" }).join("\n"), /adg plugins update --global/);
  assert.match(renderAgentReport(agents, "synced").join("\n"), /plugins sync --target codex/);
  const sourceReported = renderUpdateAgentReport(agents, { reportedFailures: ["native failed"] }).join("\n");
  assert.equal(sourceReported, "");
});
test("deferred unknown candidates remain visible separately from exclusions and do not claim full recovery", () => {
  const deferred: PluginUpdateSourceResult & { deferredRecovery: string[] } = { ...source, resumed: true, unchanged: ["installed"], deferredRecovery: ["design:a", "design:b"], notRestored: ["design:excluded"] };
  const text = renderUpdateReport(result([deferred]), { retryCommand: "adg plugins update --global --all" }).join("\n");
  assert.match(text, /recovery deferred.*2 candidates.*prior selection unknown/i);
  assert.match(text, /not restored by choice \(1\)/);
  assert.doesNotMatch(text, /recovery complete|missing upstream|design:a/);
  assert.match(text, /adg plugins update --global --all --repair/);
  const verbose = renderUpdateReport(result([deferred]), { verbose: true }).join("\n");
  assert.match(verbose, /design:a, design:b/);
  const serialized = JSON.parse(JSON.stringify(result([deferred])));
  assert.deepEqual(serialized.remote[0].deferredRecovery, ["design:a", "design:b"]);
});
test("unchanged installed selections may be up to date while deferred candidates stay visible", () => {
  const deferred: PluginUpdateSourceResult & { deferredRecovery: string[] } = { ...source, unchanged: ["installed"], deferredRecovery: ["design:a"] };
  const text = stripVTControlCharacters(renderUpdateReport(result([deferred, { ...source, source: "example/other", unchanged: ["other"] }]), { retryCommand: "adg plugins update --global --repair" }).join("\n"));
  assert.match(text, /example\/public: up to date \(1\)/);
  assert.match(text, /recovery deferred.*1 candidate/i);
  assert.equal((text.match(/--repair/g) ?? []).length, 1);
  assert.match(text, /1 other source up to date/);
  assert.doesNotMatch(text, /recovery complete|not restored by choice|missing upstream/);
});
