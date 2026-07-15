import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { AgentId, AgentSyncResult } from "./types.ts";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { getTracer, sanitizeArgs } from "../telemetry.ts";
import { runSubprocessSync } from "../subprocess.ts";

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

export type CliSpan = Pick<Span, "setAttribute" | "recordException" | "setStatus">;
type FailureSummary = { stream: "stderr" | "stdout"; text: string };

function clipText(value: string, max = 512): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function redactFailureText(value: string): string {
  return value
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/gu, "[REDACTED_TOKEN]")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s,;]+/giu, "$1[REDACTED_TOKEN]");
}

function summarizeFailure(r: SpawnSyncReturns<string>): FailureSummary | undefined {
  const stderr = r.stderr?.trim();
  if (stderr) return { stream: "stderr", text: clipText(redactFailureText(stderr)) };
  const stdout = r.stdout?.trim();
  if (stdout) return { stream: "stdout", text: clipText(redactFailureText(stdout)) };
  return undefined;
}

function recordFailureExcerpt(span: CliSpan, summary: FailureSummary | undefined): void {
  if (!summary) return;
  span.setAttribute(summary.stream === "stderr" ? "cli.stderr_excerpt" : "cli.stdout_excerpt", summary.text);
}

/**
 * Record CLI process telemetry in one place so success/failure semantics stay
 * consistent across every agent wrapper.
 */
export function annotateCliRun(span: CliSpan, bin: string, args: string[], r: SpawnSyncReturns<string>): void {
  if (r.pid !== undefined) {
    span.setAttribute("process.pid", r.pid);
  }

  if (r.status !== null) {
    span.setAttribute("process.exit.code", r.status);
    if (r.status !== 0) {
      const summary = summarizeFailure(r);
      const command = sanitizeArgs([bin, ...args]).join(" ");
      const message = summary ? `${command} exited with status ${r.status}: ${summary.text}` : `${command} exited with status ${r.status}`;
      span.setAttribute("error.type", `EXIT_CODE_${r.status}`);
      span.setAttribute("exception.slug", "cli-nonzero-exit");
      recordFailureExcerpt(span, summary);
      span.recordException(new Error(message));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message,
      });
    }
    return;
  }

  if (r.signal) {
    const summary = summarizeFailure(r);
    const command = sanitizeArgs([bin, ...args]).join(" ");
    const message = summary ? `${command} terminated by signal ${r.signal}: ${summary.text}` : `${command} terminated by signal ${r.signal}`;
    span.setAttribute("process.exit.code", -1);
    span.setAttribute("process.exit.signal", r.signal);
    span.setAttribute("error.type", `SIGNAL_${r.signal}`);
    span.setAttribute("exception.slug", "cli-signal-exit");
    recordFailureExcerpt(span, summary);
    span.recordException(new Error(message));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message,
    });
    return;
  }

  if (r.error) {
    const errCode = (r.error as any).code;
    span.setAttribute("process.exit.code", -1);
    span.setAttribute("error.type", (typeof errCode === "string" || typeof errCode === "number" ? String(errCode) : null) || r.error.name || "SpawnError");
    span.setAttribute("exception.slug", "cli-spawn-failure");
    span.recordException(r.error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: r.error.message,
    });
  }
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
    available: () => (probed ??= runSubprocessSync(bin, opts.probeArgs, { stdio: "ignore" }).status === 0),
    run: (args) => {
      const tracer = getTracer();
      return tracer.startActiveSpan(bin, { kind: SpanKind.CLIENT }, (span) => {
        try {
          span.setAttribute("process.executable.name", bin);
          span.setAttribute("process.command_args", sanitizeArgs([bin, ...args]));

          const r = spawnSync(bin, args, { encoding: "utf8" });
          annotateCliRun(span, bin, args, r);

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
