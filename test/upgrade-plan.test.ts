import { test } from "node:test";
import assert from "node:assert/strict";
import { historyIdentity, planMigration, type HistoricalPlugin } from "../src/upgrade-plan.ts";
import type { PluginContents } from "../src/components.ts";

const origin = { type: "github", repo: "example/public", ref: "main" } as const;
const contents = (skills: string[]): PluginContents => ({ skills, agents: [], commands: [], hooks: [], apps: [], mcp: [] });
const old = (extra: Partial<HistoricalPlugin> = {}): HistoricalPlugin => ({ name: "old", version: "2.0.0", origin, contents: contents(["a", "b"]), ...extra });
const candidates = [
  { name: "new", version: "3.0.0", contents: contents(["a", "extra"]) },
  { name: "other", version: "3.0.0", contents: contents(["b"]) },
];

test("inferred split preserves selected skills and disabled state", () => {
  const result = planMigration({ source: origin, installed: [old({ selection: { components: ["skills"], skills: ["a"] }, state: "disabled" })], candidates });
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.retired, ["old"]);
  assert.deepEqual(result.destinations, [{ name: "new", selection: { components: ["skills"], skills: ["a"] }, state: "disabled", predecessors: ["old"] }]);
});

test("fresh current installations and different refs do not restore historical choices", () => {
  const history = [old()];
  assert.deepEqual(planMigration({ source: origin, installed: [], history, candidates }).destinations, []);
  assert.deepEqual(planMigration({ source: origin, installed: [old({ origin: { ...origin, ref: "other" } })], history, candidates }).destinations, []);
});

test("legacy overwritten selection is reviewed once and restores only chosen historical skills", () => {
  const installed = [old({ name: "survivor", version: "3.0.0", contents: contents(["current"]) })];
  const history = [old({ name: "survivor", uncertain: true })];
  const next = [...candidates, { name: "survivor", version: "3.0.0", contents: contents(["current"]) }];
  const pending = planMigration({ source: origin, installed, history, candidates: next });
  const id = historyIdentity(history[0]!);
  assert.deepEqual(pending.decisions, [{ id, skills: ["new:a", "other:b"], choices: ["keep", "restore", "select"] }]);
  const accepted = planMigration({ source: origin, installed, history, candidates: next, decisions: { [id]: { action: "select", skills: ["other:b"] } } });
  assert.deepEqual(accepted.destinations.map(p => p.name), ["other"]);
  assert.deepEqual(accepted.destinations[0]?.selection?.skills, ["b"]);
});

test("existing full successor keeps its independent full selection", () => {
  const existing = old({ name: "new", version: "3.0.0", contents: contents(["a", "extra"]) });
  const historical = [old(), old({ name: "new", contents: contents(["extra"]) })];
  const result = planMigration({ source: origin, installed: [old(), existing], history: historical, candidates });
  assert.equal(result.destinations.find(p => p.name === "new")?.selection, undefined);
  assert.deepEqual(result.retired, ["old"]);
});

test("a surviving owner retains its old subset after skill relocation", () => {
  const result = planMigration({ source: origin, installed: [old()], candidates: [
    ...candidates, { name: "old", version: "3.0.0", contents: contents(["b", "unrelated"]) },
  ] });
  assert.deepEqual(result.destinations.find(p => p.name === "old")?.selection?.skills, ["b"]);
  assert.deepEqual(result.destinations.find(p => p.name === "new")?.selection?.skills, ["a"]);
});

test("retiring native components and unrelated successor ownership block publication", () => {
  const native = planMigration({ source: origin, installed: [old({ contents: { ...contents(["a", "b"]), hooks: ["hooks.json"] } })], candidates });
  assert.match(native.blockers.join(" "), /native components/);
  const collision = planMigration({ source: origin, installed: [old(), old({ name: "new", origin: { ...origin, repo: "other/repo" } })], candidates });
  assert.match(collision.blockers.join(" "), /different source/);
  assert.deepEqual(collision.retired, []);
});

test("rename chain order does not affect either installed predecessor", () => {
  const installed = [old({ name: "first" }), old({ name: "middle" })];
  const next = [{ name: "last", version: "4.0.0", contents: contents(["a", "b"]) }];
  const run = (renames: Record<string, string>) => planMigration({ source: origin, installed, candidates: next, renames });
  const a = run({ first: "middle", middle: "last" });
  const b = run({ middle: "last", first: "middle" });
  assert.deepEqual(a, b);
  assert.deepEqual(a.retired, ["first", "middle"]);
  assert.deepEqual(a.destinations[0]?.predecessors, ["first", "middle"]);
});

test("rename cycles and absent terminal owners fail before retirement", () => {
  for (const renames of [{ old: "middle", middle: "old" }, { old: "absent" }] as Record<string, string>[]) {
    const result = planMigration({ source: origin, installed: [old()], candidates, renames });
    assert.equal(result.blockers.length, 1);
    assert.deepEqual(result.retired, []);
  }
});

test("same-name ambiguity requires a destination decision", () => {
  const next = [...candidates, { name: "duplicate", version: "3.0.0", contents: contents(["a"]) }];
  const pending = planMigration({ source: origin, installed: [old()], candidates: next });
  assert.deepEqual(pending.decisions[0]?.skills, ["duplicate:a", "new:a"]);
  assert.deepEqual(pending.retired, []);
  const accepted = planMigration({ source: origin, installed: [old()], candidates: next,
    decisions: { "ownership:old:a": { action: "select", skills: ["new:a"] } } });
  assert.deepEqual(accepted.retired, ["old"]);
});

test("effective-only skills do not become directly requested relocation choices", () => {
  const result = planMigration({ source: origin, installed: [old({ selection: { components: ["agents"] },
    effectiveSelection: { components: ["agents", "skills"], skills: ["a"] } })], candidates });
  assert.deepEqual(result.destinations, []);
});

test("rename merges recalculate dependencies without promoting them into requested skills", () => {
  const former = old({ name: "former", contents: { ...contents(["bootstrap"]), agents: ["agent"] },
    selection: { components: ["agents"] }, effectiveSelection: { components: ["agents", "skills"], skills: ["bootstrap"] } });
  const current = old({ name: "current", contents: contents(["own", "bootstrap", "extra"]), selection: { components: ["skills"], skills: ["own"] } });
  const result = planMigration({ source: origin, installed: [former, current], renames: { former: "current" },
    candidates: [{ name: "current", version: "3.0.0", contents: { ...current.contents, agents: ["agent"] } }] });
  assert.deepEqual(result.destinations[0]?.selection, { components: ["skills", "agents"], skills: ["own"] });
});

test("rename merges preserve independent selected subsets without enabling unrelated skills", () => {
  const former = old({ name: "former", contents: contents(["a"]), selection: { components: ["skills"], skills: ["a"] } });
  const current = old({ name: "current", contents: contents(["a", "b", "extra"]), selection: { components: ["skills"], skills: ["b"] } });
  const next = [{ name: "current", version: "3.0.0", contents: contents(["a", "b", "extra"]) }];
  for (const selected of [former, { ...former, selection: undefined }]) {
    const result = planMigration({ source: origin, installed: [selected, current], candidates: next, renames: { former: "current" } });
    assert.deepEqual(result.destinations[0]?.selection?.skills, ["a", "b"]);
  }
});

test("rename chain subset merges are independent of predecessor iteration order", () => {
  const first = old({ name: "first", contents: contents(["a"]), selection: { components: ["skills"], skills: ["a"] } });
  const middle = old({ name: "middle", contents: contents(["b"]), selection: { components: ["skills"], skills: ["b"] } });
  const next = [{ name: "current", version: "3.0.0", contents: contents(["a", "b", "extra"]) }];
  const run = (installed: HistoricalPlugin[]) => planMigration({ source: origin, installed, candidates: next, renames: { first: "middle", middle: "current" } });
  assert.deepEqual(run([first, middle]), run([middle, first]));
  assert.deepEqual(run([first, middle]).destinations[0]?.selection?.skills, ["a", "b"]);
});

test("a surviving owner combines its remaining skills with incoming skills in either order", () => {
  const a = old({ name: "a", contents: contents(["one"]) });
  const b = old({ name: "b", contents: contents(["two", "three"]) });
  const next = [{ name: "b", version: "3.0.0", contents: contents(["one", "three"]) }, { name: "c", version: "3.0.0", contents: contents(["two"]) }];
  const run = (installed: HistoricalPlugin[]) => planMigration({ source: origin, installed, candidates: next });
  assert.deepEqual(run([a, b]), run([b, a]));
  assert.deepEqual(run([a, b]).destinations.find(p => p.name === "b")?.selection?.skills, ["one", "three"]);
});

test("legacy historical recovery also carries the newer currently selected skills", () => {
  const current = old({ name: "survivor", version: "3.0.0", contents: contents(["current"]) });
  const historical = old({ name: "survivor", contents: contents(["before"]), uncertain: true });
  const next = [{ name: "replacement", version: "4.0.0", contents: contents(["before", "current"]) }];
  for (const action of ["keep", "restore"] as const) {
    const result = planMigration({ source: origin, installed: [current], history: [historical], candidates: next,
      decisions: { [historyIdentity(historical)]: { action } } });
    assert.deepEqual(result.destinations[0]?.selection?.skills, action === "keep" ? ["current"] : ["before", "current"]);
  }
});

test("catalog-only rename recoveries union independently selected contributions in either order", () => {
  const first = old({ name: "first", evidence: "catalog", selectionKnown: false });
  const second = old({ name: "second", evidence: "catalog", selectionKnown: false });
  const next = [{ name: "current", version: "3.0.0", contents: contents(["a", "b", "extra"]) }];
  const run = (installed: HistoricalPlugin[]) => planMigration({ source: origin, installed, candidates: next,
    renames: { first: "current", second: "current" }, decisions: {
      [historyIdentity(first)]: { action: "select", skills: ["current:a"] },
      [historyIdentity(second)]: { action: "select", skills: ["current:b"] },
    } });
  assert.deepEqual(run([first, second]), run([second, first]));
  assert.deepEqual(run([first, second]).destinations[0]?.selection?.skills, ["a", "b"]);
  assert.deepEqual(run([first, second]).retired, ["first", "second"]);
});

test("unavailable selected skills require keep or drop before updating a surviving plugin", () => {
  const installed = [old({ selection: { components: ["skills"], skills: ["a", "b"] } })];
  const next = [{ name: "old", version: "3.0.0", contents: contents(["b", "extra"]) }];
  const run = (action?: "keep" | "drop") => planMigration({ source: origin, installed, candidates: next,
    decisions: action ? { "drop:old:a": { action } } : undefined });
  assert.deepEqual(run().decisions, [{ id: "drop:old:a", skills: ["old:a"], choices: ["keep", "drop"] }]);
  assert.deepEqual(run().destinations, []);
  const kept = run("keep");
  assert.deepEqual(kept.retained, ["old"]);
  assert.deepEqual(kept.destinations, []);
  const dropped = run("drop");
  assert.deepEqual(dropped.decisions, []);
  assert.deepEqual(dropped.retained, []);
  assert.deepEqual(dropped.destinations[0]?.selection, { components: ["skills"], skills: ["b"] });
});

test("dropping unavailable skills preserves disabled state and merges incoming selections", () => {
  const installed = [old({ selection: { components: ["skills"], skills: ["a", "b"] }, state: "disabled" }),
    old({ name: "former", contents: contents(["incoming"]), state: "disabled" })];
  const result = planMigration({ source: origin, installed,
    candidates: [{ name: "old", version: "3.0.0", contents: contents(["b", "incoming", "extra"]) }],
    decisions: { "drop:old:a": { action: "drop" } } });
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.destinations[0]?.selection?.skills, ["b", "incoming"]);
  assert.equal(result.destinations[0]?.state, "disabled");
  assert.deepEqual(result.retired, ["former"]);
});

test("dropping a newer unavailable skill does not restore uncertain historical skills", () => {
  const installed = [old({ contents: contents(["b", "c"]), selection: { components: ["skills"], skills: ["b", "c"] } })];
  const result = planMigration({ source: origin, installed,
    history: [old({ contents: contents(["historical"]), uncertain: true })],
    candidates: [{ name: "old", version: "3.0.0", contents: contents(["b", "extra"]) }],
    decisions: { "drop:old:c": { action: "drop" } } });
  assert.deepEqual(result.destinations[0]?.selection?.skills, ["b"]);
});

test("keeping an unavailable skill cannot retire a predecessor contributing to the retained plugin", () => {
  const installed = [old({ selection: { components: ["skills"], skills: ["a", "b"] } }),
    old({ name: "former", contents: contents(["incoming"]) })];
  const result = planMigration({ source: origin, installed,
    candidates: [{ name: "old", version: "3.0.0", contents: contents(["b", "incoming"]) }],
    decisions: { "drop:old:a": { action: "keep" } } });
  assert.deepEqual(result.retired, []);
  assert.deepEqual(result.destinations, []);
  assert.ok(result.blockers.length);
});

test("previously shared skill removal still requires each surviving owner's decision", () => {
  const installed = [old({ selection: { components: ["skills"], skills: ["a", "b"] } }),
    old({ name: "peer", contents: contents(["a", "own"]), selection: { components: ["skills"], skills: ["a", "own"] } })];
  const result = planMigration({ source: origin, installed, candidates: [
    { name: "old", version: "3.0.0", contents: contents(["b"]) },
    { name: "peer", version: "3.0.0", contents: contents(["own"]) },
  ] });
  assert.deepEqual(result.decisions.map(item => item.id).sort(), ["drop:old:a", "drop:peer:a"]);
});

test("dropping a legacy skill preserves only independently verified component and MCP exposure", () => {
  const catalog = { ...contents(["a", "b", "extra"]), agents: ["unselected-agent"], mcp: ["selected-server", "unselected-server"] };
  for (const effectiveSelection of [
    { components: ["skills"] as const, skills: ["a", "b"] },
    { components: ["skills", "mcp"] as const, skills: ["a", "b"], mcp: ["selected-server"] },
  ]) {
    const installed = [old({ contents: catalog, selectionKnown: false,
      effectiveSelection: { ...effectiveSelection, components: [...effectiveSelection.components] } })];
    const result = planMigration({ source: origin, installed,
      candidates: [{ name: "old", version: "3.0.0", contents: { ...catalog, skills: ["b", "extra"] } }],
      decisions: { "drop:old:a": { action: "drop" } } });
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.destinations[0]?.selection, { ...effectiveSelection, skills: ["b"] });
  }
});

test("known full skill subscriptions follow upstream deletions without review or narrowing", () => {
  for (const selection of [undefined, { components: ["skills"] as const }]) {
    const installed = [old({ selectionKnown: true,
      selection: selection ? { components: [...selection.components] } : undefined })];
    const result = planMigration({ source: origin, installed,
      candidates: [{ name: "old", version: "3.0.0", contents: contents(["b", "new"]) }] });
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.retained, []);
    assert.deepEqual(result.destinations, []);
  }
});

test("known full subscriptions retain new owner contents when deletion and relocation happen together", () => {
  for (const selection of [undefined, { components: ["skills"] as const }]) {
    const policy = selection ? { components: [...selection.components] } : undefined;
    const installed = [old({ contents: contents(["deleted", "moved", "retained"]), selectionKnown: true, selection: policy })];
    const result = planMigration({ source: origin, installed, candidates: [
      { name: "old", version: "3.0.0", contents: contents(["retained", "new"]) },
      { name: "successor", version: "3.0.0", contents: contents(["moved", "unrelated"]) },
    ] });
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.destinations.find(item => item.name === "old")?.selection, policy);
    assert.deepEqual(result.destinations.find(item => item.name === "successor")?.selection?.skills, ["moved"]);
  }
});
