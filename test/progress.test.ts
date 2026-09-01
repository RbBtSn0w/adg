import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProgress,
  formatDuration,
  formatPhase,
  formatUpdateSummary,
  type UpdatePhase,
} from "../src/render/progress.ts";

// picocolors emits ANSI whenever CI=true even off a TTY, so exact-string
// assertions must strip first (same reasoning as test/render.test.ts).
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

/** Collects writes the way a real stream would, without needing a pty. */
function fakeStream() {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") };
}

const phases: UpdatePhase[] = [
  { kind: "check", index: 2, total: 3, source: "RbBtSn0w/adg" },
  { kind: "fetch", index: 1, total: 1, source: "RbBtSn0w/adg", ref: "main" },
  { kind: "install", index: 1, total: 4, source: "RbBtSn0w/adg", plugin: "adg-core" },
  { kind: "local", index: 2, total: 2, plugin: "my-plugin" },
  { kind: "activate", agent: "claude", count: 4 },
];

test("formatPhase names the real work and its position", () => {
  const [check, fetch, install, local, activate] = phases.map((p) => stripAnsi(formatPhase(p)));
  assert.equal(check, "checking remotes (2/3) RbBtSn0w/adg");
  assert.equal(fetch, "fetching RbBtSn0w/adg@main");
  assert.equal(install, "installing (1/4) adg-core");
  assert.equal(local, "rescanning local (2/2) my-plugin");
  assert.equal(activate, "re-syncing claude — 4 plugins");
});

test("formatPhase singularizes a one-plugin agent re-sync", () => {
  assert.match(stripAnsi(formatPhase({ kind: "activate", agent: "codex", count: 1 })), /1 plugin$/);
});

test("formatPhase omits the ref when a source has none", () => {
  const line = stripAnsi(formatPhase({ kind: "fetch", index: 1, total: 1, source: "a/b" }));
  assert.equal(line, "fetching a/b");
});

test("TTY progress rewrites one line in place and never emits a newline", () => {
  const stream = fakeStream();
  const progress = createProgress({ stream, isTTY: true });
  for (const phase of phases) progress.update(phase);

  const text = stream.text();
  assert.ok(text.includes("\r"), "expected a carriage return to rewind the line");
  assert.ok(text.includes("\x1b[K"), "expected clear-to-EOL");
  // A newline here is the bug this whole module exists to avoid: it turns a
  // transient status into an accumulating log.
  assert.ok(!text.includes("\n"), "in-place progress must not emit newlines");
});

test("TTY stop() clears the line so stdout can follow cleanly", () => {
  const stream = fakeStream();
  const progress = createProgress({ stream, isTTY: true });
  progress.update(phases[0]!);
  progress.stop();
  assert.equal(stream.chunks.at(-1), "\r\x1b[K");
});

test("TTY stop() before any update writes nothing", () => {
  const stream = fakeStream();
  createProgress({ stream, isTTY: true }).stop();
  assert.equal(stream.text(), "");
});

test("non-TTY progress is one plain line per phase with no cursor control", () => {
  const stream = fakeStream();
  const progress = createProgress({ stream, isTTY: false });
  for (const phase of phases) progress.update(phase);
  progress.stop();

  const text = stream.text();
  // The CI-log regression guard: cursor movement and carriage returns are what
  // corrupt a piped log. Colors are picocolors' own call — it emits SGR codes
  // when CI=true even off a TTY (see test/render.test.ts) — so strip those
  // first and assert on what is left.
  assert.ok(!text.includes("\r"), "piped output must not contain carriage returns");
  assert.ok(
    !stripAnsi(text).includes("\x1b["),
    "piped output must not contain cursor-control sequences such as \\x1b[K",
  );
  assert.equal(text.split("\n").filter(Boolean).length, phases.length);
});

test("the returned API works when destructured", () => {
  // (Regression: methods on the returned literal used to call `this.stop()`,
  // which throws once the function is detached from the object.)
  const stream = fakeStream();
  const { update, stop, elapsedMs } = createProgress({ stream, isTTY: true });
  update(phases[0]!);
  stop();
  assert.equal(stream.chunks.at(-1), "\r\x1b[K");
  assert.equal(typeof elapsedMs(), "number");
});

test("elapsedMs measures from creation using the injected clock", () => {
  let clock = 1_000;
  const progress = createProgress({ stream: fakeStream(), isTTY: false, now: () => clock });
  clock = 3_500;
  assert.equal(progress.elapsedMs(), 2_500);
});

test("formatDuration scales from milliseconds to minutes", () => {
  assert.equal(formatDuration(420), "420ms");
  assert.equal(formatDuration(1_400), "1.4s");
  assert.equal(formatDuration(59_900), "59.9s");
  assert.equal(formatDuration(125_000), "2m 05s");
});

test("formatUpdateSummary reports failures only when there are some", () => {
  assert.equal(stripAnsi(formatUpdateSummary({ succeeded: 3, failed: 0 }, 1_400)), "3 ok · 1.4s");
  assert.equal(stripAnsi(formatUpdateSummary({ succeeded: 3, failed: 1 }, 1_400)), "3 ok · 1 failed · 1.4s");
});
