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
  assert.deepEqual(parseSelfUpdateArgs([]), {
    beta: false,
    dev: false,
    tag: undefined,
    dryRun: false,
    help: false,
  });
});

test("parseSelfUpdateArgs accepts beta flags and help", () => {
  assert.deepEqual(parseSelfUpdateArgs(["--beta"]), {
    beta: true,
    dev: false,
    tag: undefined,
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["-b"]), {
    beta: true,
    dev: false,
    tag: undefined,
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["--help"]), {
    beta: false,
    dev: false,
    tag: undefined,
    dryRun: false,
    help: true,
  });
});

test("parseSelfUpdateArgs accepts dev, tag, and dry-run flags", () => {
  assert.deepEqual(parseSelfUpdateArgs(["--dev"]), {
    beta: false,
    dev: true,
    tag: undefined,
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["--tag", "0.8.0-dev.pr42.abcdef1"]), {
    beta: false,
    dev: false,
    tag: "0.8.0-dev.pr42.abcdef1",
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["-t", "next"]), {
    beta: false,
    dev: false,
    tag: "next",
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["--tag=canary"]), {
    beta: false,
    dev: false,
    tag: "canary",
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseSelfUpdateArgs(["--dry-run"]), {
    beta: false,
    dev: false,
    tag: undefined,
    dryRun: true,
    help: false,
  });
});

test("parseSelfUpdateArgs rejects missing tag argument", () => {
  assert.throws(() => parseSelfUpdateArgs(["--tag"]), /requires a version or dist-tag/);
  assert.throws(() => parseSelfUpdateArgs(["--tag", "--dev"]), /requires a version or dist-tag/);
  assert.throws(() => parseSelfUpdateArgs(["--tag="]), /requires a version or dist-tag/);
});

test("parseSelfUpdateArgs rejects unknown flags and positionals", () => {
  assert.throws(() => parseSelfUpdateArgs(["--nope"]), /unknown flag/);
  assert.throws(() => parseSelfUpdateArgs(["beta"]), /takes no positional arguments/);
});

test("selfUpdateTarget chooses npm dist-tags and versions", () => {
  assert.equal(selfUpdateTarget(false), "latest");
  assert.equal(selfUpdateTarget(true), "beta");
  assert.equal(selfUpdateTarget({ beta: true }), "beta");
  assert.equal(selfUpdateTarget({ dev: true }), "next");
  assert.equal(selfUpdateTarget({ tag: "0.8.0-dev.pr1.1234567" }), "0.8.0-dev.pr1.1234567");
  assert.equal(selfUpdateTarget({ tag: "custom-tag", dev: true }), "custom-tag");
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
  assert.deepEqual(selfUpdateCommand({ dev: true }), {
    command: "npm",
    args: ["install", "-g", "@rbbtsn0w/adg@next"],
  });
  assert.deepEqual(selfUpdateCommand({ tag: "0.8.0-dev.pr5.fedcba9" }), {
    command: "npm",
    args: ["install", "-g", "@rbbtsn0w/adg@0.8.0-dev.pr5.fedcba9"],
  });
});

test("selfUpdateSpawnOptions enables shell on Windows only", () => {
  assert.deepEqual(selfUpdateSpawnOptions("win32"), { stdio: "inherit", shell: true });
  assert.deepEqual(selfUpdateSpawnOptions("darwin"), { stdio: "inherit", shell: false });
});

test("selfUpdateHint maps stable, beta, and dev notices to adg update commands", () => {
  assert.equal(selfUpdateHint("1.0.0"), "adg update");
  assert.equal(selfUpdateHint("1.0.0-beta.2"), "adg update --beta");
  assert.equal(selfUpdateHint("1.0.0-dev.pr4.abcdef0"), "adg update --dev");
  assert.equal(
    selfUpdateHint("1.0.0-alpha.1"),
    "adg update --tag 1.0.0-alpha.1",
  );
});

test("SELF_UPDATE_USAGE documents stable, beta, dev, tag, and dry-run forms", () => {
  assert.match(SELF_UPDATE_USAGE, /adg update/);
  assert.match(SELF_UPDATE_USAGE, /--beta/);
  assert.match(SELF_UPDATE_USAGE, /--dev/);
  assert.match(SELF_UPDATE_USAGE, /--tag/);
  assert.match(SELF_UPDATE_USAGE, /--dry-run/);
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
