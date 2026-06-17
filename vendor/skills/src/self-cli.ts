// ADG patch (new file): standalone helper for re-invoking the vendored CLI on
// `cli.ts`. Kept dependency-free (no heavy transitive imports) so a test can
// import it without pulling update.ts's graph (which currently includes the
// detect-agent.ts ↔ @vercel/detect-agent API mismatch). Mirrors the rationale
// for git-tree.ts. See vendor/skills/PROVENANCE.md.

/**
 * Args for re-invoking Node on the vendored `cli.ts`. `process.execArgv` is
 * forwarded so the child inherits the parent's Node flags (e.g.
 * --experimental-strip-types, required to run TypeScript directly on Node
 * 22.6–23.5). `execArgv` is a parameter so the forwarding can be tested with a
 * non-empty flag set.
 */
export function selfCliArgv(
  cliEntry: string,
  args: string[],
  execArgv: string[] = process.execArgv
): string[] {
  return [...execArgv, cliEntry, ...args];
}
