import { test, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { SpanKind, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getGitHubToken, resetGhAuthWarning } from "../vendor/skills/src/skill-lock.ts";

test("GitHub auth fallback warns once and never records the token in subprocess spans", async () => {
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  const warnings: string[] = [];
  const warning = mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    warnings.push(String(chunk));
    return true;
  });
  const spawn = mock.method(childProcess, "spawnSync", () => ({
    pid: 42, status: 0, signal: null, output: [null, "", ""],
    stdout: "fixture-secret-token\n", stderr: "",
  }));
  syncBuiltinESMExports();
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    resetGhAuthWarning();
    assert.equal(getGitHubToken(), "fixture-secret-token");
    assert.equal(getGitHubToken(), "fixture-secret-token");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /GitHub authentication needed/);
    assert.equal(spawn.mock.calls.length, 2);
    assert.deepEqual(spawn.mock.calls[0]!.arguments.slice(0, 2), ["gh", ["auth", "token"]]);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.ok(spans.every((span) => span.kind === SpanKind.CLIENT));
    assert.ok(spans.every((span) => span.attributes["process.exit.code"] === 0));
    assert.doesNotMatch(JSON.stringify(spans.map((span) => span.attributes)), /fixture-secret-token/);
  } finally {
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    resetGhAuthWarning();
    warning.mock.restore();
    spawn.mock.restore();
    syncBuiltinESMExports();
    trace.disable();
    await provider.shutdown();
  }
});
