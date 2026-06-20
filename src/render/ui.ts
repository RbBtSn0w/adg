import pc from "picocolors";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Semantic colors, mirroring `adg skills list` so output reads the same across
// commands: cyan = primary identifiers (plugins, agents, sources), dim =
// secondary metadata (paths, hashes, sub-details), green = success, yellow =
// notes/warnings, red = errors, bold = section titles. picocolors auto-disables
// on non-TTY / NO_COLOR, so piped output and tests stay plain.
// ---------------------------------------------------------------------------
export const ui = {
  title: (s: string) => pc.bold(s),
  name: (s: string) => pc.cyan(s),
  meta: (s: string) => pc.dim(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  err: (s: string) => pc.red(s),
} as const;

/**
 * Lay items out in aligned columns sized to the terminal width (row-major).
 * Items longer than `maxColWidth` are truncated with an ellipsis. Falls back to
 * a single column on narrow terminals. Returns the block as a string.
 */
export function formatColumns(
  items: string[],
  opts: { indent?: number; gutter?: number; maxColWidth?: number; width?: number } = {},
): string {
  const indent = opts.indent ?? 2;
  const gutter = opts.gutter ?? 2;
  const maxColWidth = opts.maxColWidth ?? 24;
  const termWidth = opts.width ?? process.stdout.columns ?? 80;

  const cells = items.map((s) => (s.length > maxColWidth ? s.slice(0, maxColWidth - 1) + "…" : s));
  const colWidth = Math.min(Math.max(1, ...cells.map((c) => c.length)), maxColWidth);
  const cols = Math.max(1, Math.floor((termWidth - indent + gutter) / (colWidth + gutter)));

  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    const padded = row.map((c, j) => (j === row.length - 1 ? c : c.padEnd(colWidth)));
    lines.push(" ".repeat(indent) + padded.join(" ".repeat(gutter)));
  }
  return lines.join("\n");
}

/** Abbreviate the home-directory prefix of an absolute path to `~` (POSIX `/` or Windows `\`). */
export function abbrevHome(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/") || p.startsWith(home + "\\")) return "~" + p.slice(home.length);
  return p;
}

/** Tail-truncate a string to width `w`, prefixing an ellipsis when it overflows. */
export function ellipsizeStart(s: string, w: number): string {
  return s.length > w ? "…" + s.slice(s.length - w + 1) : s;
}
