import { ui } from "./ui.ts";

// ---------------------------------------------------------------------------
// The single decision point for "is this a terminal we can animate?".
//
// Progress always goes to **stderr**, never stdout: `docs/cli-json.md` promises
// that `--json` leaves exactly one JSON document on stdout, and routing progress
// to the other stream keeps that true by construction rather than by remembering
// to gate every call site. For the same reason the TTY test reads
// `process.stderr.isTTY` — the rest of the CLI decides *interactivity* on stdin
// and *color* on stdout, but the stream we animate is the one that must be a
// terminal.
//
// Streams and TTY-ness are injectable so the behavior is unit-testable without a
// pty, mirroring the seam in src/commands/multiselect-skills.ts.
// ---------------------------------------------------------------------------

/** A unit of work slow enough that the user should see it happening. */
export type UpdatePhase =
  | { kind: "check"; index: number; total: number; source: string }
  | { kind: "fetch"; index: number; total: number; source: string; ref?: string }
  | { kind: "install"; index: number; total: number; source: string; plugin?: string }
  | { kind: "local"; index: number; total: number; plugin: string }
  | { kind: "activate"; agent: string; count: number };

/**
 * Render one phase as a single line. Pure, so the wording is assertable in the
 * plain-string style of test/render.test.ts. Labels name the actual cost (a
 * remote probe, a clone, an agent re-sync) rather than a generic "working…".
 */
export function formatPhase(phase: UpdatePhase): string {
  switch (phase.kind) {
    case "check":
      return `${ui.meta(`checking remotes (${phase.index}/${phase.total})`)} ${ui.name(phase.source)}`;
    case "fetch":
      return `${ui.meta("fetching")} ${ui.name(`${phase.source}${phase.ref ? `@${phase.ref}` : ""}`)}`;
    case "install": {
      const what = phase.plugin ? ui.name(phase.plugin) : ui.name(phase.source);
      return `${ui.meta(`installing (${phase.index}/${phase.total})`)} ${what}`;
    }
    case "local":
      return `${ui.meta(`rescanning local (${phase.index}/${phase.total})`)} ${ui.name(phase.plugin)}`;
    case "activate":
      return `${ui.meta("re-syncing")} ${ui.name(phase.agent)} ${ui.meta(`— ${phase.count} plugin${phase.count === 1 ? "" : "s"}`)}`;
  }
}

export interface Progress {
  /** Show `phase` as the current activity. */
  update(phase: UpdatePhase): void;
  /** Clear the animated line so subsequent stdout writes start clean. */
  stop(): void;
  /** Milliseconds since this reporter was created, for the summary line. */
  elapsedMs(): number;
}

export interface ProgressOptions {
  stream?: { write(chunk: string): unknown };
  /** Defaults to `process.stderr.isTTY`. */
  isTTY?: boolean;
  now?: () => number;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CLEAR_LINE = "\r\x1b[K";

/**
 * A deliberately minimal spinner instead of `@clack/prompts`'s: clack's writes
 * to stdout, which would break the JSON-purity contract above, and the plugins
 * domain otherwise uses clack for prompts only.
 *
 * On a TTY it rewrites one line in place (no trailing newline). Off a TTY it
 * prints one newline-terminated line per phase and `stop()` is a no-op, so a
 * piped log gets a readable trace with no cursor movement and no `\r` — those
 * are what corrupt a captured log.
 *
 * Color is deliberately NOT stripped off a TTY. Every renderer in `src/`
 * delegates that decision to picocolors (see `ui.ts`), which disables color on
 * a non-TTY or under NO_COLOR but deliberately keeps it when `CI=true`, since
 * CI log viewers render SGR. Stripping here would make progress the only
 * renderer in the repo that second-guesses that, and would leave this stderr
 * trace colorless while the stdout report beside it stayed colored.
 *
 * The frame advances per event rather than on a timer, and deliberately so: the
 * work being reported (`execFileSync` git calls, `spawnSync` agent CLIs) blocks
 * the event loop, so an interval would never fire mid-phase. Animation is not
 * available here — the phase *label*, with its counter, is what tells the user
 * the run is alive. Do not "fix" this with setInterval; it cannot tick.
 */
export function createProgress(opts: ProgressOptions = {}): Progress {
  const stream = opts.stream ?? process.stderr;
  const tty = opts.isTTY ?? Boolean(process.stderr.isTTY);
  const now = opts.now ?? (() => Date.now());
  const started = now();

  let frame = 0;
  let active = false;

  // Defined as closures rather than methods on the returned literal: nothing
  // here may depend on `this`, since callers legitimately destructure the
  // factory result (`const { update, stop } = createProgress()`).
  const update = (phase: UpdatePhase): void => {
    const line = formatPhase(phase);
    if (!tty) {
      stream.write(`${line}\n`);
      return;
    }
    stream.write(`${CLEAR_LINE}${ui.meta(FRAMES[frame % FRAMES.length]!)} ${line}`);
    frame += 1;
    active = true;
  };

  const stop = (): void => {
    if (!tty || !active) return;
    stream.write(CLEAR_LINE);
    active = false;
  };

  return { update, stop, elapsedMs: () => now() - started };
}

/** Format a wall-clock duration for the summary line (e.g. "1.4s", "2m 05s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // Round to the unit actually being printed *before* splitting into minutes
  // and seconds. Deriving the parts from the unrounded value lets a duration
  // that rounds up across a boundary render an impossible pair: 119_900ms was
  // floor(1.998)=1 minute with round(59.9)=60 seconds, i.e. "1m 60s". Choosing
  // the branch on rounded tenths likewise keeps 59_950ms out of "60.0s".
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds - minutes * 60).padStart(2, "0")}s`;
}

/**
 * The closing line of an update run. `updateResultCounts` already computes these
 * numbers for the exit code; printing them saves the user from counting rows.
 */
export function formatUpdateSummary(
  counts: { succeeded: number; failed: number },
  elapsedMs: number,
): string {
  const parts = [ui.ok(`${counts.succeeded} ok`)];
  if (counts.failed > 0) parts.push(ui.err(`${counts.failed} failed`));
  parts.push(ui.meta(formatDuration(elapsedMs)));
  return parts.join(ui.meta(" · "));
}
