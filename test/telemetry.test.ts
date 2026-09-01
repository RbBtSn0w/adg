import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attributes, Span } from "@opentelemetry/api";

import { readLock, writeLock } from "../src/lock.ts";
import { readManifest } from "../src/manifest.ts";
import {
  ADG_SAFE_POSITIONALS,
  defaultTelemetryConfig,
  normalizeTraceEndpoint,
  recordTelemetryEvent,
  sanitizePath,
  sanitizeArgs,
  withoutAmbientOtlpHeaders,
} from "../src/telemetry.ts";
import { ADG_SCHEMA_VERSION } from "../src/types.ts";
import { migrateLayout } from "../src/commands/migrate.ts";
import { installPlugin } from "../src/commands/install.ts";
import { defaultGitRunner, gitErrorType, runGit } from "../src/sources.ts";
import { PLUGIN_ALIASES, PLUGIN_COMMANDS } from "../src/cli/index.ts";

interface RecordedEvent {
  name: string;
  attributes?: Attributes;
}

test("normalizeTraceEndpoint appends the trace path exactly once", () => {
  assert.equal(normalizeTraceEndpoint("https://collector.example.com"), "https://collector.example.com/v1/traces");
  assert.equal(normalizeTraceEndpoint("https://collector.example.com/"), "https://collector.example.com/v1/traces");
  assert.equal(normalizeTraceEndpoint("https://collector.example.com/v1/traces"), "https://collector.example.com/v1/traces");
  assert.equal(
    normalizeTraceEndpoint("https://collector.example.com/root?tenant=one"),
    "https://collector.example.com/root/v1/traces?tenant=one",
  );
});

test("default telemetry config uses the anonymous gateway profile and bounded batching", () => {
  assert.deepEqual(defaultTelemetryConfig({}), {
    enabled: true,
    traceEndpoint: "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces",
    headers: { "otel-gateway-profile": "anonymous-client-v1" },
    batch: {
      maxQueueSize: 256,
      maxExportBatchSize: 64,
      scheduledDelayMillis: 100,
      exportTimeoutMillis: 1000,
    },
    exporterTimeoutMillis: 1000,
    shutdownTimeoutMillis: 1500,
  });
});

test("custom telemetry endpoint does not inherit the public profile header", () => {
  const config = defaultTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
  });
  assert.equal(config.traceEndpoint, "https://collector.example.com/v1/traces");
  assert.deepEqual(config.headers, {});
});

test("explicit approved gateway endpoint keeps the anonymous profile header", () => {
  const config = defaultTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry-gateway.hamiltonsnow.workers.dev",
  });
  assert.equal(config.traceEndpoint, "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces");
  assert.deepEqual(config.headers, { "otel-gateway-profile": "anonymous-client-v1" });
});

test("development and staging gateway endpoints keep the anonymous profile header", () => {
  for (const endpoint of [
    "https://telemetry-gateway-development.hamiltonsnow.workers.dev",
    "https://telemetry-gateway-staging.hamiltonsnow.workers.dev",
  ]) {
    const config = defaultTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    assert.deepEqual(config.headers, { "otel-gateway-profile": "anonymous-client-v1" }, endpoint);
  }
});

test("gateway profile requires the exact HTTPS origin", () => {
  for (const endpoint of [
    "http://telemetry-gateway.hamiltonsnow.workers.dev",
    "https://telemetry-gateway.hamiltonsnow.workers.dev:8443",
    "http://telemetry-gateway-development.hamiltonsnow.workers.dev",
    "https://collector.example.com",
  ]) {
    const config = defaultTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
    assert.deepEqual(config.headers, {}, endpoint);
  }

  const explicitDefaultPort = defaultTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry-gateway.hamiltonsnow.workers.dev:443",
  });
  assert.deepEqual(explicitDefaultPort.headers, {
    "otel-gateway-profile": "anonymous-client-v1",
  });
});

test("managed gateway exporter setup suppresses and restores ambient OTLP headers", () => {
  const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const originalTraceHeaders = process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  try {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer secret";
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "x-honeycomb-team=secret";
    const observed = withoutAmbientOtlpHeaders(() => ({
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      traceHeaders: process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
    }));

    assert.deepEqual(observed, {
      headers: undefined,
      traceHeaders: undefined,
    });
    assert.equal(
      process.env.OTEL_EXPORTER_OTLP_HEADERS,
      "authorization=Bearer secret",
    );
    assert.equal(
      process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS,
      "x-honeycomb-team=secret",
    );
  } finally {
    if (originalHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
    if (originalTraceHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = originalTraceHeaders;
  }
});

test("OTEL_SDK_DISABLED disables telemetry", () => {
  assert.equal(defaultTelemetryConfig({ OTEL_SDK_DISABLED: "true" }).enabled, false);
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

/*
## Test Intent
### Risk
A v3 lock can be transparently upgraded to v4 by ordinary write commands, making real migrations invisible to telemetry.
### Why Automation
The bug requires the read-then-write interaction across two lock API calls; a migration-command test does not exercise it.
### Why Existing Tests Insufficient
Existing telemetry tests cover explicit `migrate`, but not compatibility reads followed by a normal persistence path.
### Chosen Layer
Unit Test - the lock reader/writer transition is deterministic and has no filesystem or agent runtime dependency beyond a temp lock file.
### Fragility Analysis
The assertion targets the persisted lock version and public telemetry event, not internal migration bookkeeping.
### If Omitted
Production lock upgrades continue to be undercounted, defeating the telemetry-based legacy-removal decision.
*/
test("persisting a compatibility-read v3 lock records its implicit migration", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const file = join(root, ".plugin-lock.json");
  const events: RecordedEvent[] = [];
  writeFileSync(file, JSON.stringify({ version: 3, plugins: {} }));

  const lock = readLock(file, eventSpan(events));
  writeLock(file, lock, eventSpan(events));

  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 5);
  assert.deepEqual(events, [
    { name: "adg.lock.read", attributes: { "format.version": 3 } },
    { name: "adg.lock.migrate", attributes: { "from.version": 3, "to.version": 5 } },
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
    { name: "adg.lock.migrate", attributes: { "from.version": 2, "to.version": 5 } },
    { name: "adg.lock.read", attributes: { "format.version": 5 } },
  ]);
  rmSync(root, { recursive: true });
});

test("a successful v3 migration records v3 as an observed format", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-telemetry-"));
  const events: RecordedEvent[] = [];
  writeFileSync(join(root, ".plugin-lock.json"), JSON.stringify({ version: 3, plugins: {} }));

  migrateLayout(root, eventSpan(events));

  assert.deepEqual(events.filter((event) => event.name.startsWith("adg.lock")), [
    { name: "adg.lock.read", attributes: { "format.version": 3 } },
    { name: "adg.lock.migrate", attributes: { "from.version": 3, "to.version": 5 } },
    { name: "adg.lock.read", attributes: { "format.version": 5 } },
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

test("git runner runs successfully and returns nothing (or skips if git is missing)", () => {
  const originalDisable = process.env.DISABLE_TELEMETRY;
  process.env.DISABLE_TELEMETRY = "1";
  try {
    const res = defaultGitRunner(["--version"]);
    assert.equal(res, undefined);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  } finally {
    if (originalDisable === undefined) {
      delete process.env.DISABLE_TELEMETRY;
    } else {
      process.env.DISABLE_TELEMETRY = originalDisable;
    }
  }
});

test("git runner throws on failure", () => {
  const originalDisable = process.env.DISABLE_TELEMETRY;
  process.env.DISABLE_TELEMETRY = "1";
  try {
    try {
      defaultGitRunner(["--invalid-option-zzz"]);
      assert.fail("Should have thrown");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return;
      }
      assert.ok(typeof err.status === "number" && err.status !== 0, "Error status should be a non-zero number");
    }
  } finally {
    if (originalDisable === undefined) {
      delete process.env.DISABLE_TELEMETRY;
    } else {
      process.env.DISABLE_TELEMETRY = originalDisable;
    }
  }
});

/*
## Test Intent
### Risk
Git subprocess failure spans can report an unhelpful or non-string error.type, making CLI telemetry unsuitable for grouping failures.
### Why Automation
The error-type contract is a telemetry semantic convention and must remain stable across spawn and exit failures.
### Why Existing Tests Insufficient
Existing runner tests verify that failures throw, but do not assert the normalized telemetry classification.
### Chosen Layer
Unit Test - error classification is pure and does not require a real subprocess or exporter.
### Fragility Analysis
The test asserts the public low-cardinality values, not error object internals beyond the documented code/status inputs.
### If Omitted
Non-zero Git exits can collapse into generic Error classifications or emit invalid telemetry attributes.
*/
test("git error type preserves codes and classifies exits by status", () => {
  assert.equal(gitErrorType({ code: "ENOENT" }, 1), "ENOENT");
  assert.equal(gitErrorType({ code: 42 }, 1), "42");
  assert.equal(gitErrorType({ name: "Error" }, 128), "EXIT_CODE_128");
});

/*
## Test Intent
### Risk
Non-capturing Git operations can fail on a valid large repository solely because their unused stdout is buffered by Node's default maxBuffer.
### Why Automation
The failure depends on subprocess output size and is not covered by ordinary Git success tests.
### Why Existing Tests Insufficient
Existing runner tests only use tiny version/error output and therefore never exercise the buffer boundary.
### Chosen Layer
Integration Test - a local Git blob exceeds Node's default buffer without depending on network or a remote repository.
### Fragility Analysis
The assertion checks successful non-capturing execution of a known-size Git output; it does not depend on implementation details such as exact stdio options.
### If Omitted
Plugin installation and immutable cache recovery can fail on otherwise valid, noisy Git operations.
*/
test("git runner does not buffer unused large output", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-git-output-"));
  const originalDisable = process.env.DISABLE_TELEMETRY;
  process.env.DISABLE_TELEMETRY = "1";
  try {
    execFileSync("git", ["init", root]);
    writeFileSync(join(root, "large.bin"), Buffer.alloc(2 * 1024 * 1024));
    execFileSync("git", ["-C", root, "add", "large.bin"]);
    execFileSync("git", ["-C", root, "-c", "user.name=ADG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "large blob"]);
    assert.equal(runGit(["-C", root, "show", "HEAD:large.bin"]), undefined);
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw error;
  } finally {
    if (originalDisable === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = originalDisable;
    rmSync(root, { recursive: true, force: true });
  }
});

/*
## Test Intent
### Risk
Captured Git output can contain meaningful leading whitespace. Removing it changes the helper's public return value before a caller can interpret it.
### Why Automation
Only an actual Git subprocess verifies that the output-normalization boundary preserves content rather than just a mocked string.
### Why Existing Tests Insufficient
Existing Git runner coverage checks failure and large uncaptured output, but not captured output with significant whitespace.
### Chosen Layer
Integration Test - a tiny local Git repository exercises the exported helper's real capture path.
### Fragility Analysis
The assertion depends only on Git returning committed file contents, not on temporary paths, command order, or telemetry internals.
### If Omitted
A future refactor can silently strip user-visible data from every captured Git command.
*/
test("git runner preserves leading whitespace in captured output", () => {
  const root = mkdtempSync(join(tmpdir(), "adg-git-whitespace-"));
  const originalDisable = process.env.DISABLE_TELEMETRY;
  process.env.DISABLE_TELEMETRY = "1";
  try {
    execFileSync("git", ["init", root]);
    writeFileSync(join(root, "value.txt"), "  preserved leading whitespace\n");
    execFileSync("git", ["-C", root, "add", "value.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=ADG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "whitespace"]);
    assert.equal(runGit(["-C", root, "show", "HEAD:value.txt"], true), "  preserved leading whitespace");
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw error;
  } finally {
    if (originalDisable === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = originalDisable;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sanitizePath unconditionally redacts non-empty strings to [PATH]", () => {
  assert.equal(sanitizePath(undefined), "");
  assert.equal(sanitizePath(""), "");
  assert.equal(sanitizePath("/usr/local/bin"), "[PATH]");
  assert.equal(sanitizePath("~/projects/secret"), "[PATH]");
  assert.equal(sanitizePath("C:\\Users\\me"), "[PATH]");
  assert.equal(sanitizePath("relative/path"), "[PATH]");
  assert.equal(sanitizePath("plain-filename"), "[PATH]");
});

test("sanitizeArgs retains only bounded command skeletons and fixed placeholders", () => {
  const input = [
    "clone",
    "--depth",
    "1",
    "https://github.com/RbBtSn0w/adg.git",
    "dist/plugins/my-plugin",
    "--repo=https://user:pass@github.com/foo.git",
    "--token=ghp_123456",
    "Authorization: Bearer ghp_123456",
    "--repo-token-url=https://user:ghp_123456@github.com/foo.git",
    "-C/home/user",
    "-I/usr/include",
    "C:",
    "C:\\",
    "ghp_123456",
    "github_pat_123456",
  ];
  const expected = [
    "clone",
    "[FLAG]",
    "[VALUE]",
    "[VALUE]",
    "[VALUE]",
    "[FLAG]=[VALUE]",
    "[FLAG]=[VALUE]",
    "[VALUE]",
    "[FLAG]=[VALUE]",
    "[FLAG]",
    "[FLAG]",
    "[VALUE]",
    "[VALUE]",
    "[VALUE]",
    "[VALUE]",
  ];
  assert.deepEqual(sanitizeArgs(input), expected);
});

test("sanitizeArgs only retains executable-specific command skeletons", () => {
  assert.deepEqual(
    sanitizeArgs(["adg", "plugins", "add", "private-plugin", "--global"]),
    ["adg", "plugins", "add", "[VALUE]", "[FLAG]"],
  );
  assert.deepEqual(
    sanitizeArgs(["git", "clone", "owner/private-repo", "/Users/snow/private"]),
    ["git", "clone", "[VALUE]", "[VALUE]"],
  );
  assert.deepEqual(
    sanitizeArgs(["unknown-cli", "secret", "query"]),
    ["unknown-cli", "[VALUE]", "[VALUE]"],
  );
});

test("sanitizeArgs preserves safe subcommands after option values", () => {
  assert.deepEqual(
    sanitizeArgs(["git", "-C", "/Users/snow/private", "rev-parse", "HEAD"]),
    ["git", "[FLAG]", "[VALUE]", "rev-parse", "[VALUE]"],
  );
  assert.deepEqual(
    sanitizeArgs(["git", "-C", "-worktree", "rev-parse", "HEAD"]),
    ["git", "[FLAG]", "[VALUE]", "rev-parse", "[VALUE]"],
  );
  assert.deepEqual(
    sanitizeArgs(["git", "-C", "/Users/snow/private", "sparse-checkout", "set", "src"]),
    ["git", "[FLAG]", "[VALUE]", "sparse-checkout", "[VALUE]", "[VALUE]"],
  );
  assert.deepEqual(
    sanitizeArgs(["npm", "--prefix", "/Users/snow/private", "install", "private-package"]),
    ["npm", "[FLAG]", "[VALUE]", "install", "[VALUE]"],
  );
});

// Regression guard for the drift the issue describes: `sanitizeArgs`'s allowlist
// is a hand-maintained copy of the `plugins` command surface, so a new verb or
// alias added to `PLUGIN_COMMANDS`/`PLUGIN_ALIASES` without updating the
// allowlist would silently get recorded as `[VALUE]` instead of its name.
test("every PLUGIN_COMMANDS key and PLUGIN_ALIASES entry is in the sanitizeArgs allowlist", () => {
  const missingCommands = Object.keys(PLUGIN_COMMANDS).filter((verb) => !ADG_SAFE_POSITIONALS.has(verb));
  const missingAliases = Object.keys(PLUGIN_ALIASES).filter((alias) => !ADG_SAFE_POSITIONALS.has(alias));
  assert.deepEqual(missingCommands, [], "add these verbs to ADG_SAFE_POSITIONALS in src/telemetry.ts");
  assert.deepEqual(missingAliases, [], "add these aliases to ADG_SAFE_POSITIONALS in src/telemetry.ts");
});
