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
