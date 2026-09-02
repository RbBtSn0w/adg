/**
 * Pure decision model for "projection slots" — filesystem paths ADG owns a
 * generated alias/exposure at (Antigravity's convention-field aliases and its
 * external exposure symlink today; any future agent with the same
 * symlink-or-copy-fallback shape can reuse this).
 *
 * This module makes no filesystem calls. It exists to separate *deciding*
 * what to do at a path from *doing* it, because the two ad-hoc
 * implementations that predate it (`removeProjectionTarget` in
 * adapters/antigravity.ts, `rmIfSymlink`/`linkOrCopy` in
 * agents/antigravity.ts) each re-derived "is this safe to touch?" via
 * one-off lstat/existsSync checks, and every edge case that surfaced (a
 * stale symlink, a broken link, a foreign directory, a copy-fallback left
 * over where symlinks aren't available) got patched where it was found
 * rather than modeled — see the fix(antigravity) commit history and
 * https://github.com/RbBtSn0w/adg/issues/85 finding #1.
 *
 * `reconcileSlot` is the single place that decision lives now: a table over
 * two small closed unions, exhaustively tested in
 * test/projection-slot.test.ts. observeSlot/applySlotAction (the IO layer
 * that calls this) land in a later phase; this phase is additive only —
 * nothing in the codebase calls `reconcileSlot` yet.
 */

/**
 * What's actually at a slot's path. `absent`/`owned-dir`/`foreign` are
 * classified from a single lstat; `symlink.broken` additionally requires
 * resolving the link's target (an lstat alone can't tell whether it dangles).
 */
export type SlotObservation =
  | { kind: "absent" }
  | { kind: "symlink"; target: string; broken: boolean }
  /** A real (non-symlink) directory ADG created as a copy-fallback (e.g. no
   * symlink privilege on Windows) and can prove ownership of. */
  | { kind: "owned-dir" }
  /** Real content at the path that isn't provably ADG's — never touched. */
  | { kind: "foreign" };

/** What ADG wants at a slot's path. */
export type SlotDesire =
  | { kind: "absent" }
  /** The slot's path already *is* the real content (e.g. project-scope,
   * flat store); there is nothing to project. Callers detect this by path
   * equality before ever observing the slot, so `reconcileSlot` treats it
   * as a no-op regardless of `observed` rather than assuming it's
   * unreachable. */
  | { kind: "in-place" }
  | { kind: "linked"; target: string };

export type SlotAction =
  | { kind: "noop" }
  | { kind: "create-link"; target: string }
  /** Existing alias/copy points at the wrong target, or is broken/possibly
   * stale — remove whatever's there and create fresh. */
  | { kind: "relink"; target: string }
  | { kind: "remove-link" }
  /** Foreign content occupies the slot, so nothing was (or could be) done —
   * whether the desire was to create/refresh a link there, or for the slot
   * to end up absent (foreign content isn't ours to remove, so "absent"
   * can't be confirmed either). Never destructive; `reason` is a stable,
   * generic message — callers add path/name context when surfacing it (see
   * the existing warning in `exposeAt`). Distinct from `noop`, which means
   * the desired state is already actually true on disk. */
  | { kind: "skip-foreign"; reason: string };

const FOREIGN_REASON = "a real, non-ADG-owned directory or file already exists at this path";

function assertNever(x: never): never {
  throw new Error(`unreachable projection state: ${JSON.stringify(x)}`);
}

export function reconcileSlot(desired: SlotDesire, observed: SlotObservation): SlotAction {
  if (desired.kind === "in-place") return { kind: "noop" };

  if (desired.kind === "absent") {
    switch (observed.kind) {
      case "absent": return { kind: "noop" };
      case "symlink": return { kind: "remove-link" };
      case "owned-dir": return { kind: "remove-link" };
      case "foreign": return { kind: "skip-foreign", reason: FOREIGN_REASON }; // not ours; can't confirm "absent"
      default: return assertNever(observed);
    }
  }

  if (desired.kind === "linked") {
    switch (observed.kind) {
      case "absent": return { kind: "create-link", target: desired.target };
      case "symlink":
        if (observed.broken) return { kind: "relink", target: desired.target };
        return observed.target === desired.target
          ? { kind: "noop" }
          : { kind: "relink", target: desired.target };
      case "owned-dir": return { kind: "relink", target: desired.target };
      case "foreign": return { kind: "skip-foreign", reason: FOREIGN_REASON };
      default: return assertNever(observed);
    }
  }

  return assertNever(desired);
}
