import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSelfUpdateArgs,
  selfUpdateCommand,
  selfUpdateHint,
  selfUpdateTarget,
  SELF_UPDATE_USAGE,
} from "../src/self-update.ts";

test("parseSelfUpdateArgs defaults to stable update", () => {
  assert.deepEqual(parseSelfUpdateArgs([]), { beta: false, help: false });
});

test("parseSelfUpdateArgs accepts beta flags and help", () => {
  assert.deepEqual(parseSelfUpdateArgs(["--beta"]), { beta: true, help: false });
  assert.deepEqual(parseSelfUpdateArgs(["-b"]), { beta: true, help: false });
  assert.deepEqual(parseSelfUpdateArgs(["--help"]), { beta: false, help: true });
});

test("parseSelfUpdateArgs rejects unknown flags and positionals", () => {
  assert.throws(() => parseSelfUpdateArgs(["--nope"]), /unknown flag/);
  assert.throws(() => parseSelfUpdateArgs(["beta"]), /takes no positional arguments/);
});

test("selfUpdateTarget chooses npm dist-tags", () => {
  assert.equal(selfUpdateTarget(false), "latest");
  assert.equal(selfUpdateTarget(true), "beta");
});

test("selfUpdateCommand builds the npm install invocation", () => {
  assert.deepEqual(selfUpdateCommand(false), {
    command: "npm",
    args: ["install", "-g", "@rbbtsn0w/adg@latest"],
  });
  assert.deepEqual(selfUpdateCommand(true), {
    command: "npm",
    args: ["install", "-g", "@rbbtsn0w/adg@beta"],
  });
});

test("selfUpdateHint maps stable and beta notices to adg update commands", () => {
  assert.equal(selfUpdateHint("1.0.0"), "adg update");
  assert.equal(selfUpdateHint("1.0.0-beta.2"), "adg update --beta");
});

test("SELF_UPDATE_USAGE documents both stable and beta forms", () => {
  assert.match(SELF_UPDATE_USAGE, /adg update/);
  assert.match(SELF_UPDATE_USAGE, /--beta/);
});
