import { test } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { fetchAuditData, track } from "../vendor/skills/src/telemetry.ts";

test("skills event opt-outs do not disable the independent security audit request", async () => {
  const originalFetch = globalThis.fetch;
  const previousTelemetry = process.env.DISABLE_TELEMETRY;
  const previousDoNotTrack = process.env.DO_NOT_TRACK;
  const requests: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ fixture: {} }), { status: 200 });
    };
    for (const flag of ["DISABLE_TELEMETRY", "DO_NOT_TRACK"]) {
      delete process.env.DISABLE_TELEMETRY;
      delete process.env.DO_NOT_TRACK;
      process.env[flag] = "1";
      requests.length = 0;
      track({ event: "install", source: "fixture/repo", skills: "fixture", agents: "codex" });
      assert.deepEqual(await fetchAuditData("fixture/repo", ["fixture"]), { fixture: {} });
      assert.equal(requests.length, 1);
      const audit = new URL(requests[0]!);
      assert.equal(audit.origin + audit.pathname, "https://www.skills.sh/tele/audit");
      assert.equal(audit.searchParams.get("source"), "fixture/repo");
      assert.equal(audit.searchParams.get("skills"), "fixture");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousTelemetry === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = previousTelemetry;
    if (previousDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = previousDoNotTrack;
  }
});

test("skills events reuse the shared provider and omit raw source and query fields", async () => {
  const keys = ["DISABLE_TELEMETRY", "DO_NOT_TRACK", "NODE_TEST_CONTEXT", "OTEL_SDK_DISABLED"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  trace.setGlobalTracerProvider(provider);
  try {
    for (const key of keys) delete process.env[key];
    // Keep the production SDK/exporter off; the registered in-memory provider
    // captures the exact spans returned by ADG's shared getTracer().
    process.env.OTEL_SDK_DISABLED = "true";
    globalThis.fetch = async () => {
      outboundRequests++;
      return new Response("{}", { status: 200 });
    };
    track({ event: "install", source: "private-owner/private-repo", skills: "private-skill",
      agents: "private-agent", global: "1", sourceType: "github" });
    track({ event: "find", query: "secret-query", resultCount: "2", interactive: "1" });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 2);
    assert.equal(outboundRequests, 0);
    assert.equal(spans[0]!.attributes.domain, "skills");
    assert.equal(spans[0]!.attributes["adg.command.scope"], "global");
    assert.equal(spans[0]!.attributes["adg.source.type"], "github");
    assert.equal(spans[1]!.attributes["adg.skills.result_count"], 2);
    assert.doesNotMatch(JSON.stringify(spans.map((span) => span.attributes)), /private-|secret-query/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    trace.disable();
    await provider.shutdown();
  }
});
