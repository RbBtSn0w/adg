import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewUpdate } from "../src/cli/review-update.ts";

test("historical restore, selected restore and executable consent are independent", async () => {
  const prompts: string[] = [];
  const values: unknown[] = ["select", ["design:b"], true, false];
  const answer = await reviewUpdate({ source: "example/public", history: [{ id: "split", skills: ["design:a", "design:b"], choices: ["keep", "restore", "select"] }], executable: [{ key: "one", label: "New hook" }, { key: "two", label: "New command" }] }, {
    select: async options => { prompts.push(options.message); return values.shift(); },
    multiselect: async options => { prompts.push(options.message); return values.shift(); },
    confirm: async options => { prompts.push(options.message); return values.shift(); },
    isCancel: value => typeof value === "symbol",
  });
  assert.deepEqual(answer, { history: { split: { action: "select", skills: ["design:b"] } }, allow: ["one"] });
  assert.equal(prompts.length, 4);
});
test("cancellation returns no authorization and state/drop choices remain explicit", async () => {
  const cancelled = Symbol("cancel");
  assert.equal(await reviewUpdate({ source: "example/public", history: [], executable: [{ key: "one", label: "Hook" }] }, {
    select: async () => cancelled, multiselect: async () => cancelled, confirm: async () => cancelled, isCancel: value => value === cancelled,
  }), undefined);
  const values = ["disabled", "drop"];
  const answer = await reviewUpdate({ source: "example/public", history: [{ id: "state:new", skills: [], choices: ["enabled", "disabled"] }, { id: "drop:old:a", skills: ["old:a"], choices: ["keep", "drop"] }], executable: [] }, {
    select: async () => values.shift(), multiselect: async () => [], confirm: async () => false, isCancel: () => false,
  });
  assert.deepEqual(answer?.history, { "state:new": { action: "disabled" }, "drop:old:a": { action: "drop" } });
});
test("unknown retired owners default to keep and require explicit plugin removal", async () => {
  let observed: { message: string; initialValue?: string | boolean; options?: { value: string; label: string }[] } | undefined;
  const result = await reviewUpdate({ source: "example/public", history: [{ id: "unmapped:legacy", skills: ["legacy"], choices: ["keep", "drop"] }], executable: [] }, {
    select: async options => { observed = options; return "keep"; }, multiselect: async () => [], confirm: async () => false, isCancel: () => false,
  });
  assert.equal(observed?.initialValue, "keep");
  assert.match(observed?.options?.[1]?.label ?? "", /Remove the old plugin/);
  assert.deepEqual(result?.history, { "unmapped:legacy": { action: "keep" } });
});
test("skipping historical restoration clearly continues remaining updates", async () => {
  let observed: { options?: { value: string; label: string; hint?: string }[] } | undefined;
  let reviewedExecutable = false;
  const answer = await reviewUpdate({ source: "example/public", history: [{ id: "history", skills: ["design:a"], choices: ["restore", "keep", "select"] }], executable: [{ key: "new-hook", label: "New hook" }] }, {
    select: async options => { observed = options; return "keep"; },
    multiselect: async () => [], confirm: async () => { reviewedExecutable = true; return true; }, isCancel: () => false,
  });
  const skip = observed?.options?.find(option => option.value === "keep");
  assert.equal(skip?.label, "Keep current selection (Recommended)");
  assert.match(skip?.hint ?? "", /continue.*updat/i);
  assert.doesNotMatch(skip?.label ?? "", /current installation/);
  assert.equal(reviewedExecutable, true);
  assert.deepEqual(answer, { history: { history: { action: "keep" } }, allow: ["new-hook"] });
});
test("unknown prior selections default to keeping current choices and require explicit restoration", async () => {
  let question: { message: string; initialValue?: string | boolean; options?: { value: string; label: string }[] } | undefined;
  const answer = await reviewUpdate({ source: "example/public", history: [{ id: "uncertain", skills: ["design:a", "design:b"], choices: ["restore", "keep", "select"] }], executable: [] }, {
    select: async options => { question = options; return options.initialValue; }, multiselect: async () => [], confirm: async () => false, isCancel: () => false,
  });
  assert.equal(question?.initialValue, "keep");
  assert.equal(question?.options?.[0]?.value, "keep");
  assert.equal(question?.options?.[0]?.label, "Keep current selection (Recommended)");
  assert.match(question?.message ?? "", /prior selection.*unknown/i);
  assert.doesNotMatch(question?.options?.find(option => option.value === "restore")?.label ?? "", /Recommended/);
  assert.deepEqual(answer?.history, { uncertain: { action: "keep" } });
});
test("individual recovery starts with no unproven candidates selected", async () => {
  let initialValues: string[] | undefined;
  const answer = await reviewUpdate({ source: "example/public", history: [{ id: "uncertain", skills: ["design:a", "design:b"], choices: ["keep", "restore", "select"] }], executable: [] }, {
    select: async () => "select", multiselect: async options => { initialValues = options.initialValues; return options.initialValues; }, confirm: async () => false, isCancel: () => false,
  });
  assert.deepEqual(initialValues, []);
  assert.deepEqual(answer?.history, { uncertain: { action: "select", skills: [] } });
});
