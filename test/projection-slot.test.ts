import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, lstatSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileSlot,
  observeSlot,
  applySlotAction,
  OWNERSHIP_MARKER,
  FOREIGN_REASON,
  type SlotDesire,
  type SlotObservation,
  type SlotAction,
} from "../src/projection-slot.ts";

const absentObs: SlotObservation = { kind: "absent" };
const foreign: SlotObservation = { kind: "foreign" };
const ownedDir: SlotObservation = { kind: "owned-dir" };
const symlink = (target: string, broken = false): SlotObservation => ({ kind: "symlink", target, broken });

const absent: SlotDesire = { kind: "absent" };
const inPlace: SlotDesire = { kind: "in-place" };
const linked = (target: string): SlotDesire => ({ kind: "linked", target });

const noop: SlotAction = { kind: "noop" };
const removeLink: SlotAction = { kind: "remove-link" };
const createLink = (target: string): SlotAction => ({ kind: "create-link", target });
const relink = (target: string): SlotAction => ({ kind: "relink", target });
const skipForeign: SlotAction = { kind: "skip-foreign", reason: FOREIGN_REASON };

// Full desired x observed matrix — see issue #85 finding #1: this is the
// {scope, alias | in-place | copy-fallback, stale, foreign} coverage the
// finding asked for. `scope` isn't a reconcileSlot input (it only determines
// which path gets observed by the caller); the rest is exhaustive here.
const CASES: Array<{ name: string; desired: SlotDesire; observed: SlotObservation; expect: SlotAction }> = [
  // desired: absent
  { name: "nothing wanted, nothing there", desired: absent, observed: absentObs, expect: noop },
  { name: "wanted gone, our symlink is there", desired: absent, observed: symlink("/real/a"), expect: removeLink },
  { name: "wanted gone, our broken symlink is there", desired: absent, observed: symlink("/real/a", true), expect: removeLink },
  { name: "wanted gone, an owned copy-fallback dir is there", desired: absent, observed: ownedDir, expect: removeLink },
  { name: "wanted gone, foreign content is there — never touched, can't confirm absent", desired: absent, observed: foreign, expect: skipForeign },

  // desired: linked(target)
  { name: "wanted, nothing there yet", desired: linked("/real/a"), observed: absentObs, expect: createLink("/real/a") },
  { name: "wanted, already correct", desired: linked("/real/a"), observed: symlink("/real/a"), expect: noop },
  { name: "wanted, stale target (points elsewhere)", desired: linked("/real/a"), observed: symlink("/real/b"), expect: relink("/real/a") },
  { name: "wanted, broken symlink even if the target string matches", desired: linked("/real/a"), observed: symlink("/real/a", true), expect: relink("/real/a") },
  { name: "wanted, owned copy-fallback dir may be stale — always refresh", desired: linked("/real/a"), observed: ownedDir, expect: relink("/real/a") },
  { name: "wanted, foreign content blocks it", desired: linked("/real/a"), observed: foreign, expect: skipForeign },

  // desired: in-place — a no-op regardless of what's observed (callers
  // detect in-place by path equality before ever calling observeSlot, so
  // these rows document the safe-default behavior rather than an expected
  // real call shape).
  { name: "in-place, nothing observed", desired: inPlace, observed: absentObs, expect: noop },
  { name: "in-place, a symlink is somehow observed", desired: inPlace, observed: symlink("/real/a"), expect: noop },
  { name: "in-place, an owned dir is somehow observed", desired: inPlace, observed: ownedDir, expect: noop },
  { name: "in-place, foreign content is somehow observed", desired: inPlace, observed: foreign, expect: noop },
];

test("reconcileSlot covers the full desired x observed matrix", () => {
  for (const c of CASES) {
    assert.deepEqual(reconcileSlot(c.desired, c.observed), c.expect, c.name);
  }
});

test("reconcileSlot is pure: same inputs always produce a deepEqual action", () => {
  for (const c of CASES) {
    const first = reconcileSlot(c.desired, c.observed);
    const second = reconcileSlot(c.desired, c.observed);
    assert.deepEqual(first, second, c.name);
  }
});

// ── IO layer: observeSlot / applySlotAction ─────────────────────────────

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "adg-projection-slot-"));
}

function makeRealTarget(root: string): string {
  const target = join(root, "real-target");
  mkdirSync(join(target, "hello"), { recursive: true });
  writeFileSync(join(target, "hello", "SKILL.md"), "content");
  return target;
}

test("observeSlot classifies absent, symlink (working and broken), owned-dir, and foreign", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);

    assert.deepEqual(observeSlot(join(root, "nope")), { kind: "absent" });

    const workingLink = join(root, "working-link");
    symlinkSync(target, workingLink, "dir");
    assert.deepEqual(observeSlot(workingLink), { kind: "symlink", target, broken: false });

    const brokenLink = join(root, "broken-link");
    symlinkSync(join(root, "does-not-exist"), brokenLink, "dir");
    assert.deepEqual(observeSlot(brokenLink), { kind: "symlink", target: join(root, "does-not-exist"), broken: true });

    // Built through the real copy-fallback path (not a hand-rolled marker
    // file) so this exercises the actual on-disk format applySlotAction
    // produces, not an assumption about it.
    const owned = join(root, "owned");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(owned, { kind: "create-link", target }, { symlink: throwingSymlink });
    assert.deepEqual(observeSlot(owned), { kind: "owned-dir" });

    const foreignDir = join(root, "foreign-dir");
    mkdirSync(foreignDir); // no marker
    assert.deepEqual(observeSlot(foreignDir), { kind: "foreign" });

    // A directory that merely has a file with the marker's *name* but not
    // its content must not be mistaken for ownership (the spoofing case the
    // marker's magic-content check exists to close).
    const spoofed = join(root, "spoofed");
    mkdirSync(spoofed);
    writeFileSync(join(spoofed, OWNERSHIP_MARKER), "not the real marker content");
    assert.deepEqual(observeSlot(spoofed), { kind: "foreign" });

    const foreignFile = join(root, "foreign-file");
    writeFileSync(foreignFile, "not ours");
    assert.deepEqual(observeSlot(foreignFile), { kind: "foreign" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction create-link makes a real symlink when possible", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    applySlotAction(slot, { kind: "create-link", target });
    assert.deepEqual(observeSlot(slot), { kind: "symlink", target, broken: false });
    assert.deepEqual(readdirSync(slot).sort(), ["hello"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction create-link falls back to a marked owned-dir copy when symlinking fails", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink });
    assert.deepEqual(observeSlot(slot), { kind: "owned-dir" });
    assert.deepEqual(readdirSync(slot).sort(), [OWNERSHIP_MARKER, "hello"]);
    assert.ok(existsSync(join(slot, OWNERSHIP_MARKER)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction relink replaces a stale copy-fallback dir with fresh content", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink });
    writeFileSync(join(slot, "hello", "SKILL.md"), "STALE CONTENT — should be replaced");

    applySlotAction(slot, { kind: "relink", target }, { symlink: throwingSymlink });

    assert.deepEqual(observeSlot(slot), { kind: "owned-dir" });
    assert.equal(readFileSync(join(slot, "hello", "SKILL.md"), "utf8"), "content", "stale content must be replaced, not merged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction remove-link removes a symlink without touching its target", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    symlinkSync(target, slot, "dir");

    applySlotAction(slot, { kind: "remove-link" });

    assert.deepEqual(observeSlot(slot), { kind: "absent" });
    assert.ok(existsSync(target), "the real target must survive removing the alias");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction remove-link removes a broken symlink (target already gone)", () => {
  // Exercises the Node < 24 rmSync-follows-symlink quirk removeOwned works
  // around: a plain rmSync(path, {force:true}) on a broken symlink can hit
  // ENOENT at the (absent) target and have `force` swallow it without
  // unlinking the symlink itself, leaving it behind.
  const root = scratch();
  try {
    const slot = join(root, "slot");
    symlinkSync(join(root, "gone"), slot, "dir");

    applySlotAction(slot, { kind: "remove-link" });

    assert.deepEqual(observeSlot(slot), { kind: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction remove-link removes an owned copy-fallback dir recursively", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink });

    applySlotAction(slot, { kind: "remove-link" });

    assert.deepEqual(observeSlot(slot), { kind: "absent" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction remove-link refuses to delete a real directory that isn't marked as owned", () => {
  // Simulates a caller bug: remove-link reaching a path reconcileSlot never
  // actually sanctioned it for (only a symlink or owned-dir observation
  // should ever produce remove-link/relink). removeOwned re-checks the
  // marker immediately before deleting rather than trusting the action.
  const root = scratch();
  try {
    const foreignDir = join(root, "foreign");
    mkdirSync(foreignDir);
    writeFileSync(join(foreignDir, "mine.txt"), "user content");

    assert.throws(() => applySlotAction(foreignDir, { kind: "remove-link" }), /ownership marker/);
    assert.deepEqual(readdirSync(foreignDir), ["mine.txt"], "foreign content must survive the refused delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observeSlot rethrows a non-ENOENT stat failure on a symlink's target, not just the initial lstat", () => {
  // Cross-platform non-ENOENT provocation: a path *under a plain file* is
  // untraversable on every OS (ENOTDIR), unlike chmod-based permission
  // failures, which Windows doesn't express the same way (see the sibling
  // test below).
  const root = scratch();
  try {
    const blocker = join(root, "blocker-file");
    writeFileSync(blocker, "not a directory");
    const link = join(root, "link");
    symlinkSync(join(blocker, "unreachable-child"), link);
    assert.throws(() => observeSlot(link), /ENOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction noop and skip-foreign never touch disk", () => {
  const root = scratch();
  try {
    const foreignDir = join(root, "foreign");
    mkdirSync(foreignDir);
    writeFileSync(join(foreignDir, "mine.txt"), "user content");
    const before = readdirSync(foreignDir);

    applySlotAction(foreignDir, { kind: "noop" });
    applySlotAction(foreignDir, { kind: "skip-foreign", reason: "x" });

    assert.deepEqual(readdirSync(foreignDir), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe -> reconcile -> apply converges: a second pass over the same desire is a noop", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const desired: SlotDesire = { kind: "linked", target };

    const firstAction = reconcileSlot(desired, observeSlot(slot));
    applySlotAction(slot, firstAction);
    assert.deepEqual(firstAction, { kind: "create-link", target });

    const secondAction = reconcileSlot(desired, observeSlot(slot));
    applySlotAction(slot, secondAction);
    assert.deepEqual(secondAction, { kind: "noop" }, "re-running with the same desire must not touch a correct link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observe -> reconcile -> apply cleans up a copy-fallback alias once it's no longer desired (issue #85 finding #1)", () => {
  // The bug reproduced against agents/antigravity.ts while verifying finding
  // #1: a copy-fallback alias, once created, could never be reclaimed by
  // rmIfSymlink (symlink-only) once the field stopped being desired. This is
  // the same scenario through the new pipeline.
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(slot, reconcileSlot({ kind: "linked", target }, observeSlot(slot)), { symlink: throwingSymlink });
    assert.deepEqual(observeSlot(slot), { kind: "owned-dir" });

    const action = reconcileSlot({ kind: "absent" }, observeSlot(slot));
    applySlotAction(slot, action);

    assert.deepEqual(action, { kind: "remove-link" });
    assert.deepEqual(observeSlot(slot), { kind: "absent" }, "stale copy-fallback content must not survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observeSlot rethrows a non-ENOENT lstat failure instead of reporting absent", () => {
  // A path under a plain file is untraversable on every OS (ENOTDIR) — a
  // deterministic, cross-platform way to provoke a real "something's there
  // but I can't stat through it" failure, distinct from "nothing's there".
  // (A chmod-based EACCES provocation was tried first and dropped: Windows
  // CI failed it outright, since chmod there doesn't strip directory
  // traverse permission the way POSIX permission bits do.)
  const root = scratch();
  try {
    const blocker = join(root, "blocker-file");
    writeFileSync(blocker, "not a directory");
    assert.throws(() => observeSlot(join(blocker, "unreachable-child")), /ENOTDIR/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Documents actual Node behavior the copy-fallback inherits: a symlink
// nested inside the copied target is recreated as a symlink, and
// `dereference: true` does not change that (verified on Node 25 with and
// without the flag). Pinned here so a future change to the fallback's copy
// semantics is a deliberate decision rather than an accident.
test("applySlotAction copy-fallback recreates a symlink nested inside the target", () => {
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    symlinkSync(join(target, "hello", "SKILL.md"), join(target, "hello", "linked.md"));
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };

    applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink });

    const copiedLink = join(slot, "hello", "linked.md");
    assert.equal(lstatSync(copiedLink).isSymbolicLink(), true);
    assert.equal(readFileSync(copiedLink, "utf8"), "content", "and it still resolves to the right content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
