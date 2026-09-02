import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, lstatSync, statSync, symlinkSync, cpSync, rmSync } from "node:fs";
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

test("applySlotAction remove-link gives a clear refusal for a plain file, not a raw ENOTDIR", () => {
  // Same caller-bug scenario as the directory case above, but with a plain
  // file at path: hasOwnershipMarker would join the marker name onto it and
  // lstat that, which throws ENOTDIR — removeOwned must check isDirectory()
  // first so its own clear refusal error surfaces instead of that raw ENOTDIR.
  const root = scratch();
  try {
    const foreignFile = join(root, "foreign-file.txt");
    writeFileSync(foreignFile, "user content");

    assert.throws(() => applySlotAction(foreignFile, { kind: "remove-link" }), /refusing to remove/);
    assert.equal(readFileSync(foreignFile, "utf8"), "user content", "foreign file must survive the refused delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function syntheticError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

test("observeSlot rethrows a non-ENOENT stat failure on a symlink's target, not just the initial lstat", () => {
  // Two OS-dependent provocations were tried and both proved unreliable on
  // Windows CI (a chmod-based EACCES, and an ENOTDIR from nesting a path
  // under a plain file — Windows reported neither the way POSIX does).
  // Inject a synthetic error instead: it exercises the exact same rethrow
  // branch without depending on any platform's errno behavior.
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const link = join(root, "link");
    symlinkSync(target, link, "dir");
    const throwingStat: typeof statSync = () => {
      throw syntheticError("EACCES");
    };
    assert.throws(() => observeSlot(link, { stat: throwingStat }), /EACCES/);
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
  // See the injected-error comment on ObserveSlotOptions: two OS-dependent
  // provocations (chmod-based EACCES, an ENOTDIR from a path under a plain
  // file) were both tried and both failed on Windows CI, so this injects a
  // synthetic error instead of depending on platform errno behavior.
  const root = scratch();
  try {
    const throwingLstat: typeof lstatSync = () => {
      throw syntheticError("EACCES");
    };
    assert.throws(() => observeSlot(join(root, "somewhere"), { lstat: throwingLstat }), /EACCES/);
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

test("applySlotAction create-link refuses the copy-fallback when unexpected content already exists at the path", () => {
  // create-link should only ever be applied to a path just confirmed
  // absent; this simulates a caller reaching it anyway with real content
  // already there (a race or a caller bug), and asserts it's refused rather
  // than silently copied into.
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    mkdirSync(slot);
    writeFileSync(join(slot, "unexpected.txt"), "already here");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };

    assert.throws(
      () => applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink }),
      /already there|refusing/,
    );
    assert.deepEqual(readdirSync(slot), ["unexpected.txt"], "the unexpected content must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction copy-fallback marks the directory before copying, so a mid-copy failure leaves it reclaimable", () => {
  // If the marker were written after cpSync instead of before, a copy that
  // throws partway through (or a process kill, which no catch/finally would
  // even run for) would leave an unmarked partial directory that a later
  // observeSlot classifies as foreign — stuck forever, since removeOwned
  // refuses to delete anything without the marker. Injecting a cp that
  // throws proves the actual ordering, not just what the comment claims.
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    const throwingCp: typeof cpSync = () => {
      throw new Error("simulated: copy failed partway through");
    };

    assert.throws(
      () => applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink, cp: throwingCp }),
      /copy failed partway through/,
    );

    assert.deepEqual(observeSlot(slot), { kind: "owned-dir" }, "the marker must have landed before the failing copy ran");
    // And because it's reclaimable, a later relink (real cp this time) can
    // still recover it instead of being permanently stuck.
    applySlotAction(slot, { kind: "relink", target });
    assert.deepEqual(readdirSync(join(slot, "hello")), ["SKILL.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applySlotAction copy-fallback marker survives a target that happens to contain its own same-named file", () => {
  // cpSync overwrites a same-named destination file with the source's
  // version (verified directly) — so if `target`'s own tree has a root-level
  // file also named OWNERSHIP_MARKER, copying it would clobber our
  // just-written marker unless it's rewritten after the copy too.
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    writeFileSync(join(target, OWNERSHIP_MARKER), "not our marker, just a coincidence");
    const slot = join(root, "slot");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };

    applySlotAction(slot, { kind: "create-link", target }, { symlink: throwingSymlink });

    assert.deepEqual(observeSlot(slot), { kind: "owned-dir" }, "our marker must survive being overwritten by the source's own same-named file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observeSlot does not classify a spoofed symlink marker as owned-dir", () => {
  // hasOwnershipMarker must require the marker to be a real (non-symlink)
  // file with the exact magic content — otherwise a foreign directory could
  // plant .adg-owned as a symlink to any file containing that content and
  // get treated as ADG-owned (and later deleted by remove-link/relink).
  const root = scratch();
  try {
    const target = makeRealTarget(root);
    const genuine = join(root, "genuine");
    const throwingSymlink: typeof symlinkSync = () => {
      throw new Error("simulated: no symlink privilege");
    };
    applySlotAction(genuine, { kind: "create-link", target }, { symlink: throwingSymlink });
    const magicContent = readFileSync(join(genuine, OWNERSHIP_MARKER), "utf8");
    const magicElsewhere = join(root, "magic-elsewhere.txt");
    writeFileSync(magicElsewhere, magicContent);

    const spoofed = join(root, "spoofed");
    mkdirSync(spoofed);
    symlinkSync(magicElsewhere, join(spoofed, OWNERSHIP_MARKER));

    assert.deepEqual(observeSlot(spoofed), { kind: "foreign" }, "a symlinked marker must not count as ownership, even with the correct content at the far end");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
