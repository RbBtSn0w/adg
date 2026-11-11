import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyLock, readLock, writeLock } from "../src/lock.ts";
import { lockPath, pluginDir } from "../src/paths.ts";
import { folderHash } from "../src/hash.ts";
import { readManifest } from "../src/manifest.ts";
import { effectivePackageFilter } from "../src/materialize.ts";
import { PROJECTION_DIRS } from "../src/package.ts";
import { replayNativeRetries, syncNativeWithRetry } from "../src/native-retry.ts";
import type { Agent } from "../src/agents/types.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adg-native-retry-"));
  const store = join(root, "store");
  mkdirSync(store);
  const lock = emptyLock();
  lock.plugins.demo = { origin: { type: "github", repo: "example/public", ref: "stable", path: "." }, version: "1.0.0", sourceHash: "sha256-source", installedHash: "sha256-installed", installedAt: "now", updatedAt: "now" };
  const payload = pluginDir(store, "demo", lock.plugins.demo.origin);
  mkdirSync(join(payload, ".agents"), { recursive: true });
  writeFileSync(join(payload, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "demo", version: "1.0.0", description: "Synthetic retry fixture" }));
  lock.plugins.demo.installedHash = folderHash(payload, PROJECTION_DIRS, effectivePackageFilter(readManifest(payload)));
  writeLock(lockPath(store), lock);
  return { root, store, payload };
}

test("failed native refresh retries from its pinned group offline and successful replay clears it", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let fail = true;
  let refreshes = 0;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true, retrySafeOperations: ["refresh"],
    activate: () => { throw new Error("must refresh"); }, deactivate: () => ({ agent: "fake", affected: [], skipped: false }),
    refresh: ctx => { refreshes++; return { agent: "fake", affected: fail ? [] : ctx.plugins, skipped: false, ...(fail ? { failures: [{ plugin: "demo", stage: "install" as const, errorType: "TEST", message: "retry" }] } : { verified: ctx.plugins }) }; } };
  try {
    const first = await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"] });
    assert.equal(first.failures?.length, 1);
    fail = false;
    const replay = await replayNativeRetries({ pluginsDir: f.store, agents: [agent], source: "example/public" });
    assert.deepEqual(replay.groups, [{ source: "example/public", ref: "stable" }]);
    assert.deepEqual(replay.pending, []);
    assert.equal(refreshes, 2);
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).groups, []);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("replay respects saved target, disabled state, replaced sources and ref filters", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let attempts = 0;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true, retrySafeOperations: ["refresh"], activate: () => { throw new Error("unexpected"); }, deactivate: () => { throw new Error("unexpected"); }, refresh: () => { attempts++; throw new Error("interrupted"); } };
  try {
    await syncNativeWithRetry({ pluginsDir: f.store, scope: "user", agent, activate: [], refresh: ["demo"] });
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent], source: "example/public", ref: "other" })).groups, []);
    const absent = await replayNativeRetries({ pluginsDir: f.store, agents: [] });
    assert.equal(absent.pending[0]?.agent, "fake");
    assert.equal(attempts, 1);
    const lock = readLock(lockPath(f.store));
    lock.plugins.demo!.state = "disabled";
    writeLock(lockPath(f.store), lock);
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending, []);
    assert.equal(attempts, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("runtime-disabled overrides are preserved and interrupted unsafe operations are not repeated", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let calls = 0;
  let disabled = false;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
    activate: () => { calls++; throw new Error("interrupted"); }, refresh: () => { calls++; throw new Error("interrupted"); }, deactivate: () => { throw new Error("unexpected"); },
    inspectPlugins: () => [{ name: "demo", id: "demo", installed: true, enabled: !disabled }] };
  try {
    await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"], preserveRuntimeDisabled: true });
    const blocked = await replayNativeRetries({ pluginsDir: f.store, agents: [agent] });
    assert.equal(blocked.pending.length, 1);
    assert.equal(calls, 1);
    disabled = true;
    const preserved = await replayNativeRetries({ pluginsDir: f.store, agents: [agent] });
    assert.deepEqual(preserved.pending, []);
    assert.deepEqual(preserved.agents[0]?.preservedDisabled, ["demo"]);
    assert.equal(calls, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("replaced ownership clears stale requests even when the saved runtime is unavailable", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let calls = 0;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
    activate: () => { throw new Error("unexpected"); }, refresh: () => { calls++; throw new Error("interrupted"); }, deactivate: () => { throw new Error("unexpected"); } };
  try {
    await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"] });
    const lock = readLock(lockPath(f.store));
    lock.plugins.demo!.origin = { type: "github", repo: "other/source", ref: "other" };
    writeLock(lockPath(f.store), lock);
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [] })).pending, []);
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).groups, []);
    assert.equal(calls, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("explicit native removal permits fresh activation after an unsafe interrupted refresh", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let removed = false;
  let activations = 0;
  let refreshes = 0;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
    activate: ctx => { activations++; return { agent: "fake", affected: ctx.plugins, verified: ctx.plugins, skipped: false }; },
    refresh: () => { refreshes++; throw new Error("interrupted"); }, deactivate: () => { throw new Error("unexpected"); },
    inspectPlugins: () => removed ? [] : [{ name: "demo", id: "demo", installed: true, enabled: true }] };
  try {
    await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"] });
    assert.equal((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending.length, 1);
    removed = true;
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending, []);
    assert.equal(refreshes, 1);
    assert.equal(activations, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("old native membership cannot prove an adapter that performed no refresh succeeded", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
    retrySafeOperations: ["refresh"], listInstalled: () => ["demo"],
    activate: () => { throw new Error("unexpected"); }, refresh: () => ({ agent: "fake", affected: [], skipped: false }), deactivate: () => { throw new Error("unexpected"); } };
  try {
    const result = await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"] });
    assert.equal(result.failures?.length, 1);
    assert.equal((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending.length, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("modified installed bytes cannot be synchronized as the saved snapshot", async () => {
  const f = fixture();
  const oldHome = process.env.ADG_NATIVE_RETRY_HOME;
  process.env.ADG_NATIVE_RETRY_HOME = join(f.root, "private");
  let calls = 0;
  const agent: Agent = { id: "fake", displayName: "Fake", adaptTarget: "claude", detect: () => true, available: () => true,
    retrySafeOperations: ["refresh"], activate: () => { throw new Error("unexpected"); },
    refresh: () => { calls++; throw new Error("interrupted"); }, deactivate: () => { throw new Error("unexpected"); } };
  try {
    await syncNativeWithRetry({ pluginsDir: f.store, scope: "project", agent, activate: [], refresh: ["demo"] });
    writeFileSync(join(f.payload, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "demo", version: "1.0.0", description: "Changed bytes" }));
    const replay = await replayNativeRetries({ pluginsDir: f.store, agents: [agent] });
    assert.match(replay.pending[0]?.message ?? "", /no longer matches/);
    assert.equal(calls, 1);
  } finally {
    if (oldHome === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = oldHome;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native payload verification expands selection dependencies before hashing", async () => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; process.env.ADG_NATIVE_RETRY_HOME = join(f.root, 'private');
  const { resolveSelectionDependencies } = await import('../src/types.ts');
  let calls = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: ctx => { calls++; return { agent: 'fake', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unexpected refresh'); }, deactivate: () => { throw new Error('Unexpected removal'); } };
  try {
    const manifest = { schemaVersion: 'adg.plugin/v1', name: 'demo', version: '1.0.0', description: 'Synthetic dependency', hooks: './hooks/', skills: './skills/', selectionDependencies: { hooks: { components: ['skills'], skills: ['required'] } } };
    writeFileSync(join(f.payload, '.agents', '.plugin.json'), JSON.stringify(manifest));
    mkdirSync(join(f.payload, 'hooks')); writeFileSync(join(f.payload, 'hooks', 'run.sh'), 'true');
    mkdirSync(join(f.payload, 'skills', 'required'), { recursive: true }); writeFileSync(join(f.payload, 'skills', 'required', 'SKILL.md'), '# Required');
    const lock = readLock(lockPath(f.store)); lock.plugins.demo!.selection = { components: ['hooks'] };
    const parsed = readManifest(f.payload); const resolved = resolveSelectionDependencies(parsed, lock.plugins.demo!.selection);
    lock.plugins.demo!.installedHash = folderHash(f.payload, PROJECTION_DIRS, effectivePackageFilter(parsed, resolved)); writeLock(lockPath(f.store), lock);
    const result = await syncNativeWithRetry({ pluginsDir: f.store, scope: 'project', agent, activate: ['demo'], refresh: [] });
    assert.equal(result.failures, undefined); assert.equal(calls, 1);
  } finally { if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("batch persists every target before the first native adapter and replays later unavailable target", async () => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; const privateHome = join(f.root, 'private'); process.env.ADG_NATIVE_RETRY_HOME = privateHome;
  const { syncNativeBatchWithRetry } = await import('../src/native-retry.ts');
  const { readdirSync, readFileSync } = await import('node:fs');
  let laterAvailable = true; let laterCalls = 0;
  const first: Agent = { id: 'first', displayName: 'First', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: ctx => { const path = readdirSync(privateHome).find(name => name.endsWith('.json'))!; const ledger = JSON.parse(readFileSync(join(privateHome, path), 'utf8')); assert.deepEqual(ledger.requests.map((r: { agent: string }) => r.agent).sort(), ['first', 'later']); laterAvailable = false; return { agent: 'first', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unexpected refresh'); }, deactivate: () => { throw new Error('Unexpected remove'); } };
  const later: Agent = { ...first, id: 'later', available: () => laterAvailable, activate: ctx => { laterCalls++; return { agent: 'later', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; } };
  try {
    const results = await syncNativeBatchWithRetry({ pluginsDir: f.store, scope: 'project', requests: [{ agent: first, activate: ['demo'], refresh: [] }, { agent: later, activate: ['demo'], refresh: [] }] });
    assert.equal(results[0]?.failures, undefined); assert.equal(results[1]?.failures?.length, 1); assert.equal(laterCalls, 0);
    laterAvailable = true;
    const replay = await replayNativeRetries({ pluginsDir: f.store, agents: [first, later] });
    assert.deepEqual(replay.pending, []); assert.equal(laterCalls, 1);
  } finally { if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test('projection repair preserves a stored runtime-disabled intent when native registration is absent', async () => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; process.env.ADG_NATIVE_RETRY_HOME = join(f.root, 'private');
  let calls = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true, inspectPlugins: () => [],
    activate: ctx => { calls++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: ctx => { calls++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; }, deactivate: () => { throw new Error('Nothing installed'); } };
  try {
    const lock = readLock(lockPath(f.store)); lock.plugins.demo!.runtimeStates = { fake: false }; writeLock(lockPath(f.store), lock);
    const result = await syncNativeWithRetry({ pluginsDir: f.store, scope: 'project', agent, activate: [], refresh: ['demo'], preserveRuntimeDisabled: true });
    assert.equal(calls, 0); assert.deepEqual(result.preservedDisabled, ['demo']);
    assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending, []);
  } finally { if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test('native repair observes a manual enable and replaces the older disabled intent', async () => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; process.env.ADG_NATIVE_RETRY_HOME = join(f.root, 'private'); let refreshes = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'demo', name: 'demo', installed: true, enabled: true, version: '1.0.0' }],
    activate: () => { throw new Error('Unexpected activation'); }, refresh: ctx => { refreshes++; return { agent: 'fake', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; }, deactivate: () => { throw new Error('Unexpected removal'); } };
  try {
    const lock = readLock(lockPath(f.store)); lock.plugins.demo!.runtimeStates = { fake: false }; writeLock(lockPath(f.store), lock);
    const result = await syncNativeWithRetry({ pluginsDir: f.store, scope: 'project', agent, activate: [], refresh: ['demo'], preserveRuntimeDisabled: true });
    assert.deepEqual(result.affected, ['demo']); assert.equal(refreshes, 1); assert.equal(readLock(lockPath(f.store)).plugins.demo!.runtimeStates?.fake, true);
  } finally { if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test('Windows native intent persistence flushes the lock through a writable file handle', async t => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; process.env.ADG_NATIVE_RETRY_HOME = join(f.root, 'private');
  const fs = (await import('node:fs')).default; const { syncBuiltinESMExports } = await import('node:module'); const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync; const originalFstat = fs.fstatSync; const handles = new Map<number, string | number>();
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { const fd = originalOpen(...args); handles.set(fd, args[1]); return fd; });
  t.mock.method(fs, 'fsyncSync', (fd: number) => { if (originalFstat(fd).isFile()) { const flags = handles.get(fd); assert.ok(typeof flags === 'string' && /[wa+]/.test(flags), 'Windows FlushFileBuffers requires a writable file handle'); } originalFsync(fd); });
  syncBuiltinESMExports(); Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: ctx => ({ agent: 'fake', affected: ctx.plugins, verified: ctx.plugins, skipped: false }), refresh: () => { throw new Error('Unexpected'); }, deactivate: () => { throw new Error('Unexpected'); } };
  try {
    const result = await syncNativeWithRetry({ pluginsDir: f.store, scope: 'project', agent, activate: ['demo'], refresh: [] });
    assert.equal(result.failures, undefined); assert.equal(readLock(lockPath(f.store)).plugins.demo!.runtimeStates?.fake, true);
  } finally {
    Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true });
  }
});

test('native retry replays the saved lexical namespace through a canonical store entrypoint', async () => {
  const f = fixture(); const previous = process.env.ADG_NATIVE_RETRY_HOME; process.env.ADG_NATIVE_RETRY_HOME = join(f.root, 'private');
  const { symlinkSync, realpathSync } = await import('node:fs'); const alias = join(f.root, 'native-alias'); symlinkSync(f.store, alias, 'dir'); let fail = true; let calls = 0;
  const agent: Agent = { id: 'namespaced', displayName: 'Namespaced', adaptTarget: 'claude', detect: () => true, available: () => true, retrySafeOperations: ['refresh'],
    inspectPlugins: ctx => ctx.pluginsDir === alias ? [{ id: 'demo', name: 'demo', installed: true, enabled: true, version: '1.0.0' }] : [],
    listInstalled: ctx => ctx.pluginsDir === alias ? ['demo'] : [],
    activate: () => { throw new Error('Already registered in original lexical namespace'); },
    refresh: ctx => { calls++; assert.equal(ctx.pluginsDir, alias); return { agent: 'namespaced', affected: fail ? [] : ctx.plugins, skipped: false, ...(fail ? { failures: [{ plugin: 'demo', stage: 'install' as const, errorType: 'TEST', message: 'retry' }] } : { verified: ctx.plugins }) }; },
    deactivate: () => { throw new Error('Unexpected removal'); } };
  try {
    const first = await syncNativeWithRetry({ pluginsDir: alias, scope: 'project', agent, activate: [], refresh: ['demo'], preserveRuntimeDisabled: true }); assert.equal(first.failures?.length, 1);
    fail = false; const replay = await replayNativeRetries({ pluginsDir: realpathSync(f.store), agents: [agent] }); assert.deepEqual(replay.pending, []); assert.equal(calls, 2);
    rmSync(alias); assert.deepEqual((await replayNativeRetries({ pluginsDir: f.store, agents: [agent] })).pending, []); assert.equal(calls, 2);
  } finally { if (previous === undefined) delete process.env.ADG_NATIVE_RETRY_HOME; else process.env.ADG_NATIVE_RETRY_HOME = previous; rmSync(f.root, { recursive: true, force: true }); }
});
