import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync, cpSync } from "node:fs";
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
  /** `target` must be an absolute path — see `SlotObservation.symlink`. */
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

function hasOwnershipMarker(path: string): boolean {
  // existsSync never throws — it already reports any stat failure as false —
  // so there's nothing here for a try/catch to add.
  return existsSync(join(path, OWNERSHIP_MARKER));
}

/** Rethrow anything but "the path doesn't exist" — an EACCES/EPERM/ENOTDIR
 * on lstat means something real is there and unreadable, not absent; letting
 * a caller treat that as absent risks a write/removal against a path it
 * couldn't actually stat. */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Classify what's actually at `path` on disk. Makes exactly one lstat, plus
 * (for a symlink) a follow-up resolution to determine `broken`. */
export function observeSlot(path: string): SlotObservation {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return { kind: "absent" };
  }
  if (st.isSymbolicLink()) {
    return { kind: "symlink", target: resolve(dirname(path), readlinkSync(path)), broken: !existsSync(path) };
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
}

/**
 * Remove whatever `reconcileSlot` has already established is ours at `path`
 * (a symlink or an owned-dir — never foreign; `remove-link`/`relink` are
 * only ever returned for those two observations, so this trusts its caller
 * rather than re-observing).
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
  rmSync(path, { recursive: true, force: true });
}

function createLink(path: string, target: string, symlink: typeof symlinkSync): void {
  ensureDir(dirname(path));
  try {
    symlink(relative(dirname(path), target), path, "dir");
  } catch {
    // Matches `linkOrCopy` in agents/antigravity.ts, which this replaces in
    // Phase 3. Note `dereference: true` would NOT make this more robust
    // against a symlink *inside* `target`: as of Node 25 it has no effect on
    // symlinks nested in a recursive directory copy (verified — they are
    // recreated as symlinks with or without it), so it would only add a
    // claim the flag doesn't deliver. Hardening the fallback against nested
    // symlinks is a behavior change, not a port, and belongs with the real
    // call sites in Phase 3.
    cpSync(target, path, { recursive: true });
    writeFileSync(join(path, OWNERSHIP_MARKER), "");
  }
}

/** Perform the action `reconcileSlot` decided on at `path`. The only function
 * in this module that writes to disk. */
export function applySlotAction(path: string, action: SlotAction, opts: ApplySlotOptions = {}): void {
  const symlink = opts.symlink ?? symlinkSync;
  switch (action.kind) {
    case "noop":
    case "skip-foreign":
      return;
    case "remove-link":
      removeOwned(path);
      return;
    case "create-link":
      createLink(path, action.target, symlink);
      return;
    case "relink":
      removeOwned(path);
      createLink(path, action.target, symlink);
      return;
    default:
      assertNever(action);
  }
}
