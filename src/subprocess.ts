import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { basename } from "node:path";
import {
  SpanKind,
  SpanStatusCode,
  type AttributeValue,
  type Exception,
  type SpanStatus,
} from "@opentelemetry/api";
import { getTracer, sanitizeArgs } from "./telemetry.ts";

export interface SubprocessSpan {
  setAttribute(key: string, value: AttributeValue): unknown;
  recordException(exception: Exception): void;
  setStatus(status: SpanStatus): unknown;
}

interface SubprocessResult {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** Apply the OTel CLI semantic convention without collecting process output. */
export function annotateSubprocess(
  span: SubprocessSpan,
  executableName: string,
  args: string[],
  result: SubprocessResult,
): void {
  span.setAttribute("process.executable.name", executableName);
  span.setAttribute("process.command_args", sanitizeArgs([executableName, ...args]));
  if (result.pid !== undefined) span.setAttribute("process.pid", result.pid);

  if (result.status !== null) {
    span.setAttribute("process.exit.code", result.status);
    if (result.status !== 0) {
      const errorType = `EXIT_CODE_${result.status}`;
      const error = new Error(`${executableName} exited with status ${result.status}`);
      span.setAttribute("error.type", errorType);
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    return;
  }

  span.setAttribute("process.exit.code", -1);
  if (result.signal) {
    const errorType = `SIGNAL_${result.signal}`;
    const error = new Error(`${executableName} terminated by signal ${result.signal}`);
    span.setAttribute("error.type", errorType);
    span.setAttribute("process.exit.signal", result.signal);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    return;
  }

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    span.setAttribute("error.type", code ?? result.error.name ?? "SpawnError");
    span.recordException(result.error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
  }
}

export function runSubprocessSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function runSubprocessSync(
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function runSubprocessSync(
  command: string,
  args: string[],
  options: SpawnSyncOptions | SpawnSyncOptionsWithStringEncoding = {},
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const executableName = basename(command);
  return getTracer().startActiveSpan(executableName, { kind: SpanKind.CLIENT }, (span) => {
    try {
      const result = (options.encoding
        ? spawnSync(command, args, options as SpawnSyncOptionsWithStringEncoding)
        : spawnSync(command, args, options as SpawnSyncOptions)) as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
      annotateSubprocess(span, executableName, args, result);
      return result;
    } finally {
      span.end();
    }
  });
}
