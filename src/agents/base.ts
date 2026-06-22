import { spawnSync } from "node:child_process";

/** Outcome of a CLI invocation: exit success plus combined stdout+stderr. */
export interface RunResult {
  ok: boolean;
  out: string;
}

/** A CLI bound to one binary, exposing the shared availability probe and runner. */
export interface Cli {
  /** True when the binary is installed and its plugin command group responds. */
  available(): boolean;
  /** Run the binary with `args`, capturing combined output. */
  run(args: string[]): RunResult;
}

/** Options describing how an agent's CLI differs from the shared defaults. */
export interface CliOptions {
  /** Args for the availability probe (the help command that should exit 0). */
  probeArgs: string[];
  /** Echo the CLI's own stderr to ours on a non-zero exit instead of swallowing it. */
  echoStderr?: boolean;
}

/**
 * Build the shared `available()` / `run()` pair for an agent that drives an
 * external plugin CLI. Centralizing the `spawnSync` here keeps error handling,
 * output capture, and (future) timeout/env-forwarding changes in one place
 * rather than copied across every agent.
 */
export function makeCli(bin: string, opts: CliOptions): Cli {
  return {
    available: () => spawnSync(bin, opts.probeArgs, { stdio: "ignore" }).status === 0,
    run: (args) => {
      const r = spawnSync(bin, args, { encoding: "utf8" });
      // A launch failure (e.g. ENOENT for a missing binary, EACCES) leaves
      // `status` null and `stderr` empty, exposing the cause only via `error`;
      // treat that as a failure and keep its message instead of swallowing it.
      const ok = r.status === 0 && !r.error;
      if (!ok && opts.echoStderr) {
        if (r.error) console.error(r.error.message);
        else if (r.stderr) console.error(r.stderr.trim());
      }
      return { ok, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
    },
  };
}
