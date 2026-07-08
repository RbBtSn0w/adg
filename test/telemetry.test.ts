import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Attributes, Span } from "@opentelemetry/api";

import { readLock } from "../src/lock.ts";
import { readManifest } from "../src/manifest.ts";
import { normalizeTraceEndpoint, recordTelemetryEvent, sanitizePath, sanitizeArgs } from "../src/telemetry.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";
import { migrateLayout } from "../src/commands/migrate.ts";
import { installPlugin } from "../src/commands/install.ts";
import { defaultGitRunner } from "../src/sources.ts";

interface RecordedEvent {
  name: string;
  attributes?: Attributes;
}

test("normalizeTraceEndpoint appends the trace path exactly once", () => {
  assert.equal(normalizeTraceEndpoint("https://collector.example.com"), "https://collector.example.com/v1/traces");
  assert.equal(normalizeTraceEndpoint("https://collector.example.com/"), "https://collector.example.com/v1/traces");
  assert.equal(normalizeTraceEndpoint("https://collector.example.com/v1/traces"), "https://collector.example.com/v1/traces");
});

function eventSpan(events: RecordedEvent[]): Pick<Span, "addEvent"> {
  return {
    addEvent(name: string, attributes?: Attributes) {
      events.push({ name, attributes });
      return this as Span;
    },
  };
}

test("recordTelemetryEvent forwards low-cardinality attributes", () => {
  const events: RecordedEvent[] = [];
  recordTelemetryEvent(
    "adg.manifest.read",
    { "schema.version": "adg.plugin/v1" },
    eventSpan(events),
  );
  assert.deepEqual(events, [{
    name: "adg.manifest.read",
    attributes: { "schema.version": "adg.plugin/v1" },
  }]);
});

test("recordTelemetryEvent fails open when a span rejects an event", () => {
  const span: Pick<Span, "addEvent"> = {
    addEvent() {
      throw new Error("exporter failure");
    },
  };
  assert.doesNotThrow(() => recordTelemetryEvent("adg.lock.read", { "format.version": 3 }, span));
});

test("manifest and lock readers record observed format versions", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const events: RecordedEvent[] = [];
  const span = eventSpan(events);
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "demo",
    version: "1.0.0",
    description: "Demo.",
  }));
  const lockFile = join(root, ".plugin-lock.json");
  writeFileSync(lockFile, JSON.stringify({ version: 3, plugins: {} }));

  readManifest(root, span);
  readLock(lockFile, span);

  assert.deepEqual(events, [
    {
      name: "adg.manifest.read",
      attributes: { "schema.version": ADG_SCHEMA_VERSION, "manifest.layout": "canonical" },
    },
    { name: "adg.lock.read", attributes: { "format.version": 3 } },
  ]);
  rmSync(root, { recursive: true });
});

test("legacy manifest layout is measurable without recording its path", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const events: RecordedEvent[] = [];
  mkdirSync(join(root, ".adg-plugin"), { recursive: true });
  writeFileSync(join(root, ".adg-plugin", "plugin.json"), JSON.stringify({
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "demo",
    version: "1.0.0",
    description: "Demo.",
  }));

  readManifest(root, eventSpan(events));

  assert.deepEqual(events, [{
    name: "adg.manifest.read",
    attributes: { "schema.version": ADG_SCHEMA_VERSION, "manifest.layout": "legacy" },
  }]);
  rmSync(root, { recursive: true });
});

test("an unsupported lock version is recorded before validation fails", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const file = join(root, ".plugin-lock.json");
  const events: RecordedEvent[] = [];
  writeFileSync(file, JSON.stringify({ version: 2, plugins: {} }));

  assert.throws(() => readLock(file, eventSpan(events)), /unsupported lock version 2/);
  assert.deepEqual(events, [{ name: "adg.lock.read", attributes: { "format.version": 2 } }]);
  rmSync(root, { recursive: true });
});

test("a successful v2 migration records read and transition versions", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const installed = join(root, "demo");
  const events: RecordedEvent[] = [];
  mkdirSync(join(installed, ".agents"), { recursive: true });
  writeFileSync(join(installed, ".agents", ".plugin.json"), JSON.stringify({
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "demo",
    version: "1.0.0",
    description: "Demo.",
  }));
  writeFileSync(join(root, ".plugin-lock.json"), JSON.stringify({
    version: 2,
    plugins: {
      demo: {
        origin: { type: "local", path: installed },
        version: "1.0.0",
        folderHash: "sha256-legacy",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
  }));

  migrateLayout(root, eventSpan(events));

  assert.deepEqual(events.filter((event) => event.name.startsWith("adg.lock")), [
    { name: "adg.lock.read", attributes: { "format.version": 2 } },
    { name: "adg.lock.migrate", attributes: { "from.version": 2, "to.version": 3 } },
    { name: "adg.lock.read", attributes: { "format.version": 3 } },
  ]);
  rmSync(root, { recursive: true });
});

test("a failed v2 migration does not report a completed transition", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const events: RecordedEvent[] = [];
  mkdirSync(join(root, "demo"), { recursive: true });
  writeFileSync(join(root, ".plugin-lock.json"), JSON.stringify({
    version: 2,
    plugins: {
      demo: {
        origin: { type: "local", path: join(root, "demo") },
        version: "1.0.0",
        folderHash: "sha256-legacy",
        installedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
  }));

  assert.throws(() => migrateLayout(root, eventSpan(events)), /manifest/i);
  assert.equal(events.some((event) => event.name === "adg.lock.migrate"), false);
  rmSync(root, { recursive: true });
});

test("installPlugin records selection counts in telemetry", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const pluginDir = join(root, "demo");
  mkdirSync(join(pluginDir, ".agents"), { recursive: true });
  writeFileSync(join(pluginDir, ".agents", ".plugin.json"), JSON.stringify({
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "demo",
    version: "1.0.0",
    description: "Demo.",
    skills: ["./skills/hello"],
  }));
  mkdirSync(join(pluginDir, "skills", "hello"), { recursive: true });
  writeFileSync(join(pluginDir, "skills", "hello", "SKILL.md"), "# Hello");

  const store = join(root, "store");
  const events: RecordedEvent[] = [];
  const span = eventSpan(events);

  installPlugin({
    source: pluginDir,
    pluginsDir: store,
    now: "2026-06-11T00:00:00Z",
    selection: {
      components: ["skills"],
      skills: ["hello"],
    },
    telemetrySpan: span as any,
  });

  const selectionEvents = events.filter((e) => e.name === "adg.install.selection");
  assert.equal(selectionEvents.length, 1);
  const firstEvent = selectionEvents[0];
  assert.ok(firstEvent);
  assert.deepEqual(firstEvent.attributes, {
    plugin: "demo",
    "components.count": 1,
    "skills.count": 1,
    "mcp.count": -1,
  });

  rmSync(root, { recursive: true });
});

test("git runner runs successfully and returns nothing", () => {
  assert.doesNotThrow(() => defaultGitRunner(["--version"]));
});

test("git runner throws on failure", () => {
  assert.throws(() => defaultGitRunner(["invalid-git-command-zzz"]));
});

test("sanitizePath redacts homedir and replaces with tilde, keeping only basename", () => {
  const home = homedir();
  if (home) {
    const testPath = `${home}/some/project/path`;
    assert.equal(sanitizePath(testPath), "~/path");
  }
  const temp = tmpdir();
  if (temp) {
    const testTemp = `${temp}/some-temp-file`;
    assert.equal(sanitizePath(testTemp), "[TMP]/some-temp-file");
  }
  // Safe fallback for null, undefined, empty path
  assert.equal(sanitizePath(undefined), "");
  assert.equal(sanitizePath(""), "");
  
  // Tilde-prefixed paths are kept as tilde-prefixed with basename
  assert.equal(sanitizePath("~/some/project/path"), "~/path");
  assert.equal(sanitizePath("~"), "~");

  // Non-home absolute paths are redacted with basename
  assert.equal(sanitizePath("/var/log/syslog"), "[REDACTED_PATH]/syslog");

  // Relative paths containing separators are redacted with basename
  assert.equal(sanitizePath("dist/plugins/my-plugin"), "[REDACTED_PATH]/my-plugin");
});

test("sanitizeArgs redacts raw paths but keeps options/flags and URLs", () => {
  const home = homedir();
  const input = [
    "clone",
    "--depth",
    "1",
    "-C",
    `${home}/some/project`,
    "https://github.com/RbBtSn0w/adg.git",
    "dist/plugins/my-plugin"
  ];
  const expected = [
    "clone",
    "--depth",
    "1",
    "-C",
    "~/project",
    "https://github.com/RbBtSn0w/adg.git",
    "[REDACTED_PATH]/my-plugin"
  ];
  assert.deepEqual(sanitizeArgs(input), expected);
});
