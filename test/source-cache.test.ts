import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { context, INVALID_SPAN_CONTEXT, trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import { installPlugin } from "../src/commands/install.ts";
import { resolvePluginSourceSnapshot } from "../src/source-cache.ts";
import { legacyPluginSourceCacheDir, pluginSourceCacheDir } from "../src/paths.ts";
import { readLock } from "../src/lock.ts";
import { initPlugin } from "../src/commands/init.ts";
import { tmp } from "./helpers.ts";

interface RecordedEvent {
  name: string;
  attributes?: Attributes;
}

function eventSpan(events: RecordedEvent[]): Span {
  return Object.assign(trace.wrapSpanContext(INVALID_SPAN_CONTEXT), {
    addEvent(name: string, attributes?: Attributes) {
      events.push({ name, attributes });
      return this as Span;
    },
  });
}

function withEventSpan<T>(span: Span, fn: () => T): T {
  let active: Context = trace.setSpan(context.active(), span);
  const manager = {
    active: () => active,
    with<T>(next: Context, callback: (...args: any[]) => T, thisArg?: any, ...args: any[]): T {
      const previous = active;
      active = next;
      try {
        return callback.apply(thisArg, args);
      } finally {
        active = previous;
      }
    },
    bind<T>(_: Context, target: T): T { return target; },
    enable() { return this; },
    disable() { return this; },
  };
  context.setGlobalContextManager(manager);
  try {
    return fn();
  } finally {
    context.disable();
  }
}

test("source snapshot adopts a verified legacy cache into the system cache", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "legacy-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["legacy-cache"]!;
  const cache = pluginSourceCacheDir(store, "legacy-cache");
  const legacy = legacyPluginSourceCacheDir(store, "legacy-cache");
  mkdirSync(join(legacy, ".."), { recursive: true });
  // The installed cache is known-good; moving it models an old ADG install.
  rmSync(cache, { recursive: true, force: true });
  cpSync(pluginDir, legacy, { recursive: true });

  assert.equal(resolvePluginSourceSnapshot(store, "legacy-cache", entry), cache);
  assert.ok(existsSync(cache));
  rmSync(work, { recursive: true, force: true });
});

test("source snapshot rejects a cache whose full-payload hash no longer matches the lock", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "tampered-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["tampered-cache"]!;
  writeFileSync(join(pluginSourceCacheDir(store, "tampered-cache"), "README.md"), "tampered");

  assert.throws(() => resolvePluginSourceSnapshot(store, "tampered-cache", entry), /source cache integrity mismatch/);
  rmSync(work, { recursive: true, force: true });
});

/*
## Test Intent
### Risk
A malformed modern cache snapshot can fail before hash verification without recording a terminal recovery outcome, undercounting recovery failures.
### Why Automation
The missing event occurs only on the real cache-hit branch with an active telemetry span; a unit test of the event helper cannot prove that boundary.
### Why Existing Tests Insufficient
Existing failure coverage exercises legacy and local recovery after the modern cache is absent, not malformed modern snapshots.
### Chosen Layer
Integration Test - a temporary plugin store reaches the public snapshot resolver's modern-cache path.
### Fragility Analysis
The test observes only the public manifest error and telemetry outcome, not private filesystem operations.
### If Omitted
Modern-cache corruption remains invisible in recovery reliability telemetry.
*/
test("failed modern cache validation records an unrecoverable outcome", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "modern-failure", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["modern-failure"]!;
  rmSync(join(pluginSourceCacheDir(store, "modern-failure"), ".agents", ".plugin.json"), { force: true });
  const events: RecordedEvent[] = [];

  assert.throws(
    () => withEventSpan(eventSpan(events), () => resolvePluginSourceSnapshot(store, "modern-failure", entry)),
    /Invalid ADG manifest/,
  );
  assert.deepEqual(events.filter((event) => event.name === "adg.cache.recovery"), [{
    name: "adg.cache.recovery",
    attributes: { outcome: "missing_unrecoverable" },
  }]);
  rmSync(work, { recursive: true, force: true });
});

test("source snapshot repopulates the system cache from a verified local origin", () => {
  const work = tmp();
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "local-cache", dir: join(work, "source") });
  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["local-cache"]!;
  const cache = pluginSourceCacheDir(store, "local-cache");
  rmSync(cache, { recursive: true, force: true });

  assert.equal(resolvePluginSourceSnapshot(store, "local-cache", entry), cache);
  assert.ok(existsSync(cache));
  rmSync(work, { recursive: true, force: true });
});

/*
## Test Intent
### Risk
Legacy and local recovery can fail after cache lookup (for example, while parsing or materializing a source) without recording a terminal recovery outcome.
### Why Automation
The missing telemetry is only observable across the recovery branch and its active span; a successful restore test cannot prove failure accounting.
### Why Existing Tests Insufficient
Existing recovery tests cover successful legacy adoption and local restoration, but not malformed source payloads after the cache is missing.
### Chosen Layer
Integration Test - temporary plugin stores exercise both recovery branches with deterministic malformed manifests.
### Fragility Analysis
The test asserts only the public recovery outcome and error surface, not internal helper calls or filesystem paths.
### If Omitted
Corrupted legacy/local sources would silently disappear from recovery telemetry and distort cache reliability measurements.
*/
test("failed legacy and local recovery records an unrecoverable outcome", () => {
  for (const mode of ["legacy", "local"] as const) {
    const work = tmp();
    const store = join(work, "store");
    const { pluginDir } = initPlugin({ name: `${mode}-failure`, dir: join(work, "source") });
    installPlugin({ source: pluginDir, pluginsDir: store });
    const entry = readLock(join(store, ".plugin-lock.json")).plugins[`${mode}-failure`]!;
    rmSync(pluginSourceCacheDir(store, `${mode}-failure`), { recursive: true, force: true });
    const source = mode === "legacy" ? legacyPluginSourceCacheDir(store, `${mode}-failure`) : pluginDir;
    if (mode === "legacy") {
      mkdirSync(join(source, ".."), { recursive: true });
      cpSync(pluginDir, source, { recursive: true });
    }
    rmSync(join(source, ".agents", ".plugin.json"), { force: true });
    const events: RecordedEvent[] = [];
    let thrown: unknown;
    try {
      withEventSpan(eventSpan(events), () => resolvePluginSourceSnapshot(store, `${mode}-failure`, entry));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /Invalid ADG manifest/);
    assert.deepEqual(events.filter((event) => event.name === "adg.cache.recovery"), [{
      name: "adg.cache.recovery",
      attributes: { outcome: "missing_unrecoverable" },
    }]);
    rmSync(work, { recursive: true, force: true });
  }
});

/*
## Test Intent
### Risk
A remote snapshot whose contents do not match its locked hash can be reported as both a hash mismatch and an unrecoverable missing cache, which inflates recovery telemetry and hides the actual failure mode.
### Why Automation
The regression requires the exact remote-restore failure path and cannot be proven by inspecting the two event calls independently.
### Why Existing Tests Insufficient
Existing tests assert rejection of a corrupted already-cached payload, but do not exercise the remote restore path's catch boundary.
### Chosen Layer
Integration Test - a local Git repository exercises the real immutable-revision restore flow without network dependency.
### Fragility Analysis
The test asserts only the externally recorded recovery outcome for a deliberately mismatched locked hash; it does not depend on Git command order or temporary paths.
### If Omitted
Recovery telemetry can double-count failures and incorrectly suggest that an integrity failure is a cache-availability problem.
*/
test("remote restore reports a hash mismatch as its only recovery outcome", () => {
  const work = tmp();
  const repo = join(work, "repo");
  const store = join(work, "store");
  const { pluginDir } = initPlugin({ name: "remote-mismatch", dir: repo });
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=ADG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  installPlugin({ source: pluginDir, pluginsDir: store });
  const entry = readLock(join(store, ".plugin-lock.json")).plugins["remote-mismatch"]!;
  rmSync(pluginSourceCacheDir(store, "remote-mismatch"), { recursive: true, force: true });
  const events: RecordedEvent[] = [];
  const remoteEntry = {
    ...entry,
    origin: { type: "git" as const, url: repo, path: relative(repo, pluginDir) },
    resolvedRevision: revision,
    sourceHash: "sha256-intentionally-mismatched",
  };

  let thrown: unknown;
  try {
    withEventSpan(eventSpan(events), () => resolvePluginSourceSnapshot(store, "remote-mismatch", remoteEntry));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /cannot restore.*source cache integrity mismatch/);
  assert.deepEqual(events.filter((event) => event.name === "adg.cache.recovery"), [{
    name: "adg.cache.recovery",
    attributes: { outcome: "hash_mismatch" },
  }]);
  rmSync(work, { recursive: true, force: true });
});
