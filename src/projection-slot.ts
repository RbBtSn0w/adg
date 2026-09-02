import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ensureDir } from "./fsutil.ts";

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
 * test/projection-slot.test.ts. `observeSlot`/`applySlotAction` are this
 * module's IO layer — the only functions here that touch a filesystem, and
 * the only ones that need `reconcileSlot`'s output rather than deciding for
 * themselves. Phase 3 rewires `agents/antigravity.ts` and
 * `adapters/antigravity.ts` to delegate to this pipeline; this phase is
 * still additive only — nothing outside this module and its tests calls
 * any of these three functions yet.
 */

/**
 * What's actually at a slot's path. `absent`/`owned-dir`/`foreign` are
 * classified from a single lstat; `symlink.broken` additionally requires
 * resolving the link's target (an lstat alone can't tell whether it dangles).
 */
export type SlotObservation =
  | { kind: "absent" }
  /** `target` is resolved to an absolute path (a symlink is stored relative
   * to its own directory, so it survives a move, but is resolved here to be
   * directly comparable to `SlotDesire.linked.target`, which is always
   * absolute — see `reconcileSlot`'s stale-target check). */
  | { kind: "symlink"; target: string; broken: boolean }
  /** A real (non-symlink) directory ADG created as a copy-fallback (e.g. no
   * symlink privilege on Windows) and can prove ownership of — see
   * `OWNERSHIP_MARKER` below. */
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
  /** `target` must be an absolute, normalized path (no `.`/`..` segments):
   * `reconcileSlot` compares it to `SlotObservation.symlink.target` by strict
   * string equality, and that side is normalized by `resolve`, so an
   * unnormalized desire spuriously reads as stale and relinks every call. */
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

/** Exported so tests assert against this exact string instead of duplicating it. */
export const FOREIGN_REASON = "a real, non-ADG-owned directory or file already exists at this path";

/**
 * Only the variant's `kind` is included in the thrown message, never the
 * full object: a `SlotObservation`/`SlotDesire`/`SlotAction` can carry a
 * `target` (a filesystem path), and this path is meant to be unreachable —
 * if it's ever hit anyway (a bug, or a caller bypassing the type checker),
 * the error shouldn't be the thing that leaks a path into a log or an
 * uncaught-exception report.
 */
function assertNever(x: never): never {
  const kind = typeof x === "object" && x !== null && "kind" in x ? String((x as { kind: unknown }).kind) : "unknown";
  throw new Error(`unreachable projection state: ${kind}`);
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

// ── IO layer ─────────────────────────────────────────────────────────────

/**
 * Marker file written at the root of every copy-fallback directory this
 * module creates (`<dir>/.adg-owned`), so a later `observeSlot` can tell it
 * apart from a same-shaped foreign directory — a real (non-symlink) dir
 * otherwise carries no signal of who created it. Exported so a caller that
 * needs to construct the marker path itself (e.g. to exclude it from a
 * content listing) doesn't have to duplicate the filename.
 */
export const OWNERSHIP_MARKER = ".adg-owned";

/**
 * A directory merely named `.adg-owned` proves nothing — a foreign directory
 * could coincidentally contain that name, or someone could create it
 * deliberately, and either way `observeSlot` would misclassify real content
 * as ours to `remove-link`/`relink`. Require exact content, not just
 * presence, so the marker can't be spoofed by an empty or arbitrary file.
 */
const OWNERSHIP_MARKER_MAGIC = "adg-projection-slot/v1\n";

function hasOwnershipMarker(path: string): boolean {
  const markerPath = join(path, OWNERSHIP_MARKER);
  try {
    // lstat first, not just readFileSync (which follows symlinks): a
    // foreign directory could plant `.adg-owned` as a symlink to some other
    // file that happens to contain the magic string, spoofing ownership.
    // Require the marker to be a real, non-symlink regular file.
    if (!lstatSync(markerPath).isFile()) return false;
    return readFileSync(markerPath, "utf8") === OWNERSHIP_MARKER_MAGIC;
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return false;
  }
}

/** Rethrow anything but "the path doesn't exist" — an EACCES/EPERM/ENOTDIR
 * on lstat means something real is there and unreadable, not absent; letting
 * a caller treat that as absent risks a write/removal against a path it
 * couldn't actually stat. */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isBrokenLink(path: string, stat: typeof statSync): boolean {
  try {
    stat(path); // follows the link
    return false;
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return true;
  }
}

export interface ObserveSlotOptions {
  /**
   * Injectable so the rethrow-non-ENOENT paths can be tested deterministically,
   * without depending on an OS to actually produce a non-ENOENT stat failure.
   * Two attempts at that were tried and both failed on Windows CI: chmod-based
   * EACCES (Windows doesn't strip directory traverse permission the way POSIX
   * permission bits do) and a path nested under a plain file, expecting
   * ENOTDIR (Windows apparently reports a different errno for that shape —
   * the assertion saw no exception at all, meaning it resolved as ENOENT
   * there). Rather than keep guessing at Windows errno behavior this session
   * can't verify directly, the rethrow logic is exercised by injecting a stub
   * that throws a synthetic non-ENOENT error, on every platform alike.
   * Default to the real `lstatSync`/`statSync`.
   */
  lstat?: typeof lstatSync;
  stat?: typeof statSync;
}

/**
 * Classify what's actually at `path` on disk: one lstat, plus a follow-up
 * stat of the target to determine `broken` for a symlink, or a read of the
 * ownership marker file to distinguish `owned-dir` from `foreign` for a real
 * directory.
 */
export function observeSlot(path: string, opts: ObserveSlotOptions = {}): SlotObservation {
  const lstat = opts.lstat ?? lstatSync;
  const stat = opts.stat ?? statSync;
  let st;
  try {
    st = lstat(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: resolve(dirname(path), readlinkSync(path)),
      // stat (follows the link), not existsSync: existsSync reports any
      // failure as false, so an EACCES/EPERM on the target would be read as
      // "broken" and drive a destructive relink. Only ENOENT means broken;
      // anything else rethrows, same as the lstat above.
      broken: isBrokenLink(path, stat),
    };
  }
  if (st.isDirectory() && hasOwnershipMarker(path)) {
    return { kind: "owned-dir" };
  }
  return { kind: "foreign" };
}

export interface ApplySlotOptions {
  /** Injectable so tests can force the copy-fallback path deterministically,
   * without relying on a real symlink-privilege failure (Windows-specific,
   * and named `node:fs` imports elsewhere in the codebase can't be
   * monkey-patched through an ESM namespace object). Defaults to the real
   * `symlinkSync`. */
  symlink?: typeof symlinkSync;
  /** Injectable so a test can prove the marker-before-copy ordering actually
   * protects against a copy that fails partway through, instead of just
   * asserting it in a comment. Defaults to the real `cpSync`. */
  cp?: typeof cpSync;
}

/**
 * Remove whatever `reconcileSlot` has already established is ours at `path`
 * (a symlink or an owned-dir — never foreign; `remove-link`/`relink` are
 * only ever returned for those two observations). A symlink is trusted and
 * removed outright; a real directory is re-checked for the ownership marker
 * immediately before the recursive delete, rather than fully trusting the
 * caller's already-computed action — the cheap belt-and-suspenders check
 * that actually bounds the blast radius of a caller bug or a stale action.
 *
 * Symlink removal uses `unlinkSync`, not `rmSync(..., { force: true })`: on
 * Node < 24 the latter follows the link, hits `ENOENT` at the (possibly
 * absent) target, and `force` then swallows that error without unlinking
 * the symlink itself — the same quirk `rmIfSymlink` in agents/antigravity.ts
 * works around today.
 */
function removeOwned(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return; // already absent
  }
  if (st.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  // Re-check right before the recursive delete rather than fully trusting
  // the caller's action: reconcileSlot only ever returns remove-link/relink
  // for a symlink or owned-dir observation, but a caller bug, a stale action
  // computed against an earlier observation, or a race could still reach
  // here with something else — including a plain file, not just a foreign
  // directory. Check that explicitly before hasOwnershipMarker: joining the
  // marker name onto a file path and lstat'ing it throws ENOTDIR, which
  // would otherwise surface in place of this function's own clear refusal.
  if (!st.isDirectory()) {
    throw new Error(
      `refusing to remove ${path}: it is a real file, not a directory or symlink — ` +
        "removeOwned must only ever be called for a symlink or an owned-dir observation",
    );
  }
  if (!hasOwnershipMarker(path)) {
    throw new Error(
      `refusing to remove ${path}: it is a real directory without the ADG ownership marker (${OWNERSHIP_MARKER}) — ` +
        "removeOwned must only ever be called for a symlink or an owned-dir observation",
    );
  }
  rmSync(path, { recursive: true, force: true });
}

function createLink(path: string, target: string, symlink: typeof symlinkSync, cp: typeof cpSync): void {
  ensureDir(dirname(path));
  try {
    symlink(relative(dirname(path), target), path, "dir");
    return;
  } catch {
    // fall through to the copy fallback below
  }

  // create-link/relink should only ever reach here right after path was
  // confirmed absent (relink's caller already ran removeOwned; create-link's
  // caller only fires on an absent observation) — but don't fully trust
  // that: a race against another process, or a caller bug, could still land
  // real content here between the observation and this call. Refuse to copy
  // into/over it rather than silently merging or overwriting.
  if (observeSlot(path).kind !== "absent") {
    throw new Error(`refusing copy-fallback at ${path}: expected it to be absent, but something is already there`);
  }

  // Matches `linkOrCopy` in agents/antigravity.ts, which this replaces in
  // Phase 3. Note `dereference: true` would NOT make this more robust
  // against a symlink *inside* `target`: as of Node 25 it has no effect on
  // symlinks nested in a recursive directory copy (verified — they are
  // recreated as symlinks with or without it), so it would only add a
  // claim the flag doesn't deliver. Hardening the fallback against nested
  // symlinks is a behavior change, not a port, and belongs with the real
  // call sites in Phase 3.
  //
  // Marker written both before AND after the (potentially large, potentially
  // failing) recursive copy — each half guards a different failure:
  //  - Before: if cp throws partway through, or the process is killed
  //    outright (no catch/finally runs for that case either way), the
  //    marker has already landed, so the next observeSlot classifies the
  //    partial directory as owned-dir (reclaimable via relink) rather than
  //    foreign (unrecoverable by ADG). Relies on cp merging into an
  //    already-existing destination directory rather than erroring —
  //    verified separately.
  //  - After: if `target` itself contains a root-level file also named
  //    OWNERSHIP_MARKER, cp overwrites our just-written marker with that
  //    file's content when it copies target's own tree — verified directly
  //    (cpSync does overwrite a same-named destination file with the
  //    source's version). Rewriting after a successful copy guarantees the
  //    final on-disk marker is ours regardless of what target contained.
  const markerPath = join(path, OWNERSHIP_MARKER);
  mkdirSync(path);
  writeFileSync(markerPath, OWNERSHIP_MARKER_MAGIC);
  cp(target, path, { recursive: true });
  writeFileSync(markerPath, OWNERSHIP_MARKER_MAGIC);
}

/** Perform the action `reconcileSlot` decided on at `path`. The only function
 * in this module that writes to disk. */
export function applySlotAction(path: string, action: SlotAction, opts: ApplySlotOptions = {}): void {
  const symlink = opts.symlink ?? symlinkSync;
  const cp = opts.cp ?? cpSync;
  switch (action.kind) {
    case "noop":
    case "skip-foreign":
      return;
    case "remove-link":
      removeOwned(path);
      return;
    case "create-link":
      createLink(path, action.target, symlink, cp);
      return;
    case "relink":
      removeOwned(path);
      createLink(path, action.target, symlink, cp);
      return;
    default:
      assertNever(action);
  }
}
