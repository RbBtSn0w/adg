import { spawnSync } from "node:child_process";
import type { AgentId, AgentSyncResult } from "./types.ts";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer, sanitizeArgs } from "../telemetry.ts";

/** Outcome of a CLI invocation: exit success plus combined stdout+stderr. */
export interface RunResult {
  ok: boolean;
  out: string;
}

/**
 * The canonical "CLI absent, so nothing was touched" lifecycle result. Every
 * agent's activate/deactivate guard returns this shape; centralizing it keeps
 * the agent id the single thing that varies and rules out a hand-typed drift
 * (e.g. a wrong `agent` field or a missing `skipped`).
 */
export function skippedResult(agent: AgentId): AgentSyncResult {
  return { agent, affected: [], skipped: true };
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
  // A CLI's presence can't change within a single `adg` run, yet `available()`
  // is called as a guard on every agent lifecycle op (and once per plugin in
  // some loops). Memoize the first probe so one `plugins update --both` can't
  // re-shell the same `--help` many times. Cached on first call, not eagerly,
  // so importing an agent module never spawns a subprocess.
  let probed: boolean | undefined;
  return {
    available: () => (probed ??= spawnSync(bin, opts.probeArgs, { stdio: "ignore" }).status === 0),
    run: (args) => {
      const tracer = getTracer();
      return tracer.startActiveSpan(bin, { kind: SpanKind.CLIENT }, (span) => {
        try {
          span.setAttribute("process.executable.name", bin);
          span.setAttribute("process.command_args", sanitizeArgs([bin, ...args]));

          const r = spawnSync(bin, args, { encoding: "utf8" });

          if (r.pid !== undefined) {
            span.setAttribute("process.pid", r.pid);
          }
          if (r.status !== null) {
            span.setAttribute("process.exit.code", r.status);
            if (r.status !== 0) {
              span.setAttribute("error.type", `EXIT_CODE_${r.status}`);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: `Command exited with non-zero status ${r.status}`,
              });
            }
          } else if (r.error) {
            span.setAttribute("process.exit.code", -1);
            const errCode = (r.error as any).code;
            span.setAttribute("error.type", (typeof errCode === "string" || typeof errCode === "number" ? String(errCode) : null) || r.error.name || "SpawnError");
            span.recordException(r.error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: r.error.message,
            });
          }

          const ok = r.status === 0 && !r.error;
          if (!ok && opts.echoStderr) {
            if (r.error) console.error(r.error.message);
            else if (r.stderr) console.error(r.stderr.trim());
          }
          return { ok, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
        } finally {
          span.end();
        }
      });
    },
  };
}
