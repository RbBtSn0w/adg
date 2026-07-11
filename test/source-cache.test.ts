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
