import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SpanKind, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { runNtnApi } from "../vendor/skills/src/notion-test.ts";
import { tmp } from "./helpers.ts";

test("Notion command failures record a bounded subprocess span", async () => {
  const dir = tmp();
  const previousPath = process.env.PATH;
  const previousTelemetry = process.env.DISABLE_TELEMETRY;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  try {
    process.env.PATH = dir;
    process.env.DISABLE_TELEMETRY = "1";
    await assert.rejects(runNtnApi(["api", "/v1/ai/skills/private-page-id"]), /Notion CLI/);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    const span = spans[0]!;
    assert.equal(span.name, "ntn");
    assert.equal(span.kind, SpanKind.CLIENT);
    assert.equal(span.attributes["process.executable.name"], "ntn");
    assert.equal(span.attributes["process.exit.code"], -1);
    assert.equal(span.attributes["error.type"], "ENOENT");
    assert.doesNotMatch(JSON.stringify(span.attributes), /private-page-id|executable\.path/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTelemetry === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = previousTelemetry;
    trace.disable();
    await provider.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Notion command output and exit status survive subprocess instrumentation", {
  skip: process.platform === "win32" && "Executable symlinks require Windows privileges",
}, async () => {
  const dir = tmp();
  const previousPath = process.env.PATH;
  const previousTelemetry = process.env.DISABLE_TELEMETRY;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  try {
    symlinkSync(process.execPath, join(dir, "ntn"));
    process.env.PATH = dir;
    process.env.DISABLE_TELEMETRY = "1";
    assert.equal(await runNtnApi(["-e", "process.stdout.write('{}')"]), "{}");
    await assert.rejects(runNtnApi(["-e", "process.stderr.write('fixture');process.exit(7)"]), /fixture/);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(spans[0]!.attributes["process.exit.code"], 0);
    assert.equal(spans[1]!.attributes["process.exit.code"], 7);
    assert.equal(spans[1]!.attributes["error.type"], "EXIT_CODE_7");
    assert.doesNotMatch(JSON.stringify(spans.map((span) => span.attributes)), /fixture|stdout|stderr/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTelemetry === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = previousTelemetry;
    trace.disable();
    await provider.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
