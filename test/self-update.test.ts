import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatSelfUpdateResult,
  formatSelfUpdateStart,
  parseSelfUpdateArgs,
  selfUpdateCommand,
  selfUpdateFailureHint,
  selfUpdateHint,
  selfUpdateSpawnOptions,
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

test("selfUpdateSpawnOptions enables shell on Windows only", () => {
  assert.deepEqual(selfUpdateSpawnOptions("win32"), { stdio: "inherit", shell: true });
  assert.deepEqual(selfUpdateSpawnOptions("darwin"), { stdio: "inherit", shell: false });
});

test("selfUpdateHint maps stable and beta notices to adg update commands", () => {
  assert.equal(selfUpdateHint("1.0.0"), "adg update");
  assert.equal(selfUpdateHint("1.0.0-beta.2"), "adg update --beta");
  assert.equal(
    selfUpdateHint("1.0.0-alpha.1"),
    "npm install -g @rbbtsn0w/adg@1.0.0-alpha.1",
  );
});

test("SELF_UPDATE_USAGE documents both stable and beta forms", () => {
  assert.match(SELF_UPDATE_USAGE, /adg update/);
  assert.match(SELF_UPDATE_USAGE, /--beta/);
});

// `adg update` used to print nothing of its own: npm install -g is silent for
// several seconds, so the command named "update" looked hung at t=0.
test("formatSelfUpdateStart states the version delta and the command being run", () => {
  const line = formatSelfUpdateStart("0.7.1", false);
  assert.match(line, /^adg 0\.7\.1 → installing latest /);
  assert.match(line, /npm install -g @rbbtsn0w\/adg@latest/);
});

test("formatSelfUpdateStart reflects the beta channel", () => {
  const line = formatSelfUpdateStart("0.7.1", true);
  assert.match(line, /installing beta/);
  assert.match(line, /@rbbtsn0w\/adg@beta/);
});

test("formatSelfUpdateResult reports outcome and elapsed time", () => {
  assert.match(formatSelfUpdateResult(true, 4200), /^updated · 4\.2s/);
  assert.equal(formatSelfUpdateResult(false, 1500), "update failed · 1.5s");
});

test("selfUpdateFailureHint gives a runnable next step", () => {
  const hint = selfUpdateFailureHint(false);
  assert.match(hint, /npm install -g @rbbtsn0w\/adg@latest/);
  assert.match(hint, /EACCES/);
});
