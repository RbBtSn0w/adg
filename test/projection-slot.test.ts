import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileSlot, type SlotDesire, type SlotObservation, type SlotAction } from "../src/projection-slot.ts";

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
const skipForeign: SlotAction = { kind: "skip-foreign", reason: "a real, non-ADG-owned directory or file already exists at this path" };

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
  { name: "wanted gone, foreign content is there — never touched", desired: absent, observed: foreign, expect: noop },

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
