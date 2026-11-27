import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { runSubprocessSync } from '../src/subprocess.ts';
import { getTracer, shutdownTelemetry } from '../src/telemetry.ts';

export function runReleaseCommand(executable, args, { cwd, env }) {
  const { status, stdout, stderr, error } = runSubprocessSync(executable, args, {
    cwd, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  }, { captureArgs: false });
  if (error || status !== 0) {
    // Console diagnostics are separate from telemetry. Do not attach this message to the span.
    throw new Error(`Release subprocess failed (${status ?? error?.code ?? 'interrupted'}): ${stderr || stdout || error?.message}`);
  }
  return stdout.trim();
}

export async function withReleaseToolchainSpan(executableName, operation) {
  return getTracer('development').startActiveSpan(executableName, {
    kind: SpanKind.INTERNAL,
    attributes: { 'process.executable.name': executableName, 'process.pid': process.pid },
  }, async span => {
    let exitCode = 0;
    try {
      await operation();
    } catch (error) {
      console.error(error);
      exitCode = 1;
      process.exitCode = exitCode;
      span.setAttribute('error.type', 'ReleaseToolchainError');
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.setAttribute('process.exit.code', exitCode);
      span.end();
      await shutdownTelemetry();
    }
  });
}
