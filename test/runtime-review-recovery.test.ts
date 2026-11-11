import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPlugins } from '../src/commands/install.ts';
import { updatePlugins } from '../src/commands/marketplace.ts';
import { readLock, writeLock } from '../src/lock.ts';
import { lockPath } from '../src/paths.ts';
import type { Agent } from '../src/agents/types.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'adg-runtime-review-')); const store = join(root, 'store'); const remote = join(root, 'remote');
  const previous = { cache: process.env.ADG_CACHE_HOME, migration: process.env.ADG_MIGRATION_HOME, mutex: process.env.ADG_MUTEX_HOME };
  process.env.ADG_CACHE_HOME = join(root, 'cache'); process.env.ADG_MIGRATION_HOME = join(root, 'private'); process.env.ADG_MUTEX_HOME = join(root, 'mutex');
  t.after(() => { for (const [key, value] of [['ADG_CACHE_HOME', previous.cache], ['ADG_MIGRATION_HOME', previous.migration], ['ADG_MUTEX_HOME', previous.mutex]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const plugin = (name: string, version: string) => { const dir = join(remote, name); mkdirSync(join(dir, '.agents'), { recursive: true }); writeFileSync(join(dir, '.agents', '.plugin.json'), JSON.stringify({ schemaVersion: 'adg.plugin/v1', name, version, description: 'Synthetic review', skills: './skills/' })); mkdirSync(join(dir, 'skills', 'one'), { recursive: true }); writeFileSync(join(dir, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: Synthetic\n---\nOne\n'); };
  const clone = (args: string[]) => { if (args[0] === 'clone') cpSync(remote, args.at(-1)!, { recursive: true }); };
  return { root, store, remote, plugin, clone };
}

test('repair keeps Codex work across another runtime failure and an offline transaction replay', async t => {
  const f = fixture(t); f.plugin('demo', '1.0.0'); f.plugin('peer', '1.0.0');
  await addPlugins({ spec: 'example/review', pluginsDir: f.store, all: true, gitRunner: f.clone, agents: [] });
  let fail = true; const codexNames = new Map([['demo', '1.0.0']]); const claudeNames = new Map([['demo', '1.0.0'], ['peer', '1.0.0']]); let codexWrites = 0;
  const provider = (id: string, names: Map<string, string>): Agent => ({ id, displayName: id, adaptTarget: id === 'codex' ? 'codex' : 'claude', detect: () => true, available: () => true, retrySafeOperations: ['refresh'],
    inspectPlugins: () => [...names].map(([name, version]) => ({ id: name, name, installed: true, enabled: true, version })),
    listInstalled: () => [...names.keys()],
    activate: ctx => { if (id === 'codex') codexWrites++; for (const name of ctx.plugins) names.set(name, readLock(lockPath(f.store)).plugins[name]!.version); return { agent: id, affected: ctx.plugins, skipped: false }; },
    refresh: ctx => { if (id !== 'codex' && fail) return { agent: id, affected: [], skipped: false, failures: [{ stage: 'install', plugin: ctx.plugins[0], errorType: 'TEST', message: 'retry native' }] }; if (id === 'codex') codexWrites++; for (const name of ctx.plugins) names.set(name, readLock(lockPath(f.store)).plugins[name]!.version); return { agent: id, affected: ctx.plugins, skipped: false }; },
    deactivate: () => { throw new Error('No retirement'); } });
  const agents = [provider('claude', claudeNames), provider('codex', codexNames)]; f.plugin('demo', '2.0.0');
  const first = await updatePlugins({ pluginsDir: f.store, agents, gitRunner: f.clone, activate: true, repair: true, revisionResolver: () => 'revision-two' });
  assert.ok(first.remote[0]?.pendingRuntime?.length); assert.equal(codexNames.get('demo'), '2.0.0'); assert.equal(codexNames.get('peer'), '1.0.0');
  const count = codexWrites; fail = false; rmSync(f.remote, { recursive: true });
  const replay = await updatePlugins({ pluginsDir: f.store, agents, activate: true, repair: true, revisionResolver: () => { throw new Error('Must resume offline'); }, gitRunner: () => { throw new Error('Must not clone'); } });
  assert.equal(replay.remote[0]?.resumed, true); assert.equal(replay.remote[0]?.pendingRuntime, undefined); assert.equal(codexWrites, count);
});

test('activate false retains registered predecessor and later activation completes retirement offline', async t => {
  const f = fixture(t); f.plugin('former', '1.0.0'); await addPlugins({ spec: 'example/review', pluginsDir: f.store, all: true, gitRunner: f.clone, agents: [] });
  const native = new Map([['former', '1.0.0']]); const calls: string[] = [];
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [...native].map(([name, version]) => ({ id: name, name, installed: true, enabled: true, version })),
    activate: ctx => { calls.push(`activate:${ctx.plugins[0]}`); native.set(ctx.plugins[0]!, '2.0.0'); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('New identity must activate'); },
    deactivate: ctx => { calls.push(`retire:${ctx.plugins[0]}`); native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  rmSync(join(f.remote, 'former'), { recursive: true }); f.plugin('next', '2.0.0'); mkdirSync(join(f.remote, '.agents'), { recursive: true }); writeFileSync(join(f.remote, '.agents', '.marketplace.json'), JSON.stringify({ name: 'review', renames: { former: 'next' }, plugins: [{ name: 'next', source: './next' }] }));
  const first = await updatePlugins({ pluginsDir: f.store, agents: [agent], gitRunner: f.clone, activate: false, revisionResolver: () => 'revision-two' });
  assert.ok(first.remote[0]?.pendingRuntime?.length); assert.ok(readLock(lockPath(f.store)).plugins.former); assert.deepEqual(calls, []); assert.equal(native.has('former'), true);
  const still = await updatePlugins({ pluginsDir: f.store, agents: [agent], activate: false, revisionResolver: () => { throw new Error('Must resume offline'); } }); assert.ok(still.remote[0]?.pendingRuntime?.length); assert.deepEqual(calls, []);
  rmSync(f.remote, { recursive: true });
  const final = await updatePlugins({ pluginsDir: f.store, agents: [agent], activate: true, revisionResolver: () => { throw new Error('Must resume offline'); } });
  assert.equal(final.remote[0]?.resumed, true); assert.deepEqual(calls, ['activate:next', 'retire:former']); assert.equal(native.has('former'), false); assert.equal(readLock(lockPath(f.store)).plugins.former, undefined);
});

test('an older journal for a nonfirst ref keeps same-version Codex repair eligible', async t => {
  const f = fixture(t); f.plugin('primary', '1.0.0'); f.plugin('secondary', '1.0.0');
  const { installPlugin } = await import('../src/commands/install/install-one.ts');
  const { prepareMigrationTransaction, publishMigrationTransaction } = await import('../src/migration-transaction.ts');
  const { pluginSourceCacheDir } = await import('../src/paths.ts');
  const firstOrigin = { type: 'github' as const, repo: 'example/review', ref: 'main', path: 'primary' };
  const secondOrigin = { ...firstOrigin, ref: 'stable', path: 'secondary' };
  installPlugin({ source: join(f.remote, 'primary'), pluginsDir: f.store, origin: firstOrigin, resolvedRevision: 'main-old', targets: [] });
  installPlugin({ source: join(f.remote, 'secondary'), pluginsDir: f.store, origin: secondOrigin, resolvedRevision: 'stable-old', targets: [] });
  writeFileSync(join(f.remote, 'secondary', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: Synthetic\n---\nUpdated same-version bytes\n');
  const stage = join(f.root, 'stage'); const built = installPlugin({ source: join(f.remote, 'secondary'), pluginsDir: stage, origin: secondOrigin, resolvedRevision: 'stable-new', targets: [] });
  const claude: Agent = { id: 'claude', displayName: 'Claude', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'secondary', name: 'secondary', installed: true, enabled: true, version: '1.0.0' }],
    activate: () => { throw new Error('Existing identity'); }, refresh: ctx => { const receipt = JSON.parse(readFileSync(journal, 'utf8')); assert.ok(receipt.operations.some((op: { agent: string }) => op.agent === 'codex'), 'Codex obligation must be durable before a legacy native callback can complete'); return { agent: 'claude', affected: ctx.plugins, skipped: false }; }, deactivate: () => { throw new Error('No retirement'); } };
  const writes: string[] = []; let failRepair = true;
  const codex: Agent = { id: 'codex', displayName: 'Codex', adaptTarget: 'codex', detect: () => true, available: () => true, retrySafeOperations: ['refresh'],
    inspectPlugins: () => ['primary', 'secondary'].map(name => ({ id: name, name, installed: true, enabled: true, version: '1.0.0' })),
    activate: ctx => { writes.push(...ctx.plugins); return failRepair ? { agent: 'codex', affected: [], skipped: false, failures: [{ stage: 'install' as const, errorType: 'TEST', message: 'Legacy Codex outage' }] } : { agent: 'codex', affected: ctx.plugins, skipped: false }; }, refresh: ctx => { writes.push(...ctx.plugins); return failRepair ? { agent: 'codex', affected: [], skipped: false, failures: [{ stage: 'install' as const, errorType: 'TEST', message: 'Legacy Codex outage' }] } : { agent: 'codex', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; }, deactivate: () => { throw new Error('No retirement'); } };
  // This models an existing receipt from the version that did not schedule Codex.
  const journal = await prepareMigrationTransaction({ pluginsDir: f.store, source: 'example/review', ref: 'stable', revision: 'stable-new', prepared: [{ name: 'secondary', dir: built.installedTo, entry: readLock(lockPath(stage)).plugins.secondary!, cacheDir: pluginSourceCacheDir(stage, 'secondary') }], retire: [], scope: 'project', targets: [claude] });
  assert.equal((await publishMigrationTransaction(journal, { targets: [] })).complete, false);
  const result = await updatePlugins({ pluginsDir: f.store, source: 'example/review', activate: true, repair: true, agents: [claude, codex], revisionResolver: (_source, ref) => { assert.equal(ref, 'main'); return 'main-old'; }, gitRunner: () => { throw new Error('No source checkout needed'); } });
  assert.ok(result.remote.find(item => item.ref === 'stable')?.pendingRuntime?.length); assert.deepEqual(writes, ['secondary']);
  const pendingReceipt = JSON.parse(readFileSync(journal, 'utf8')); assert.equal(pendingReceipt.complete, false); assert.ok(pendingReceipt.operations.some((op: { agent: string }) => op.agent === 'codex'));
  assert.ok(result.agents.find(item => item.agent === 'codex')?.failures?.some(item => item.message === 'Legacy Codex outage'));
  failRepair = false;
  const retry = await updatePlugins({ pluginsDir: f.store, source: 'example/review', activate: true, repair: true, agents: [claude, codex], revisionResolver: (_source, ref) => { assert.equal(ref, 'main'); return 'main-old'; }, gitRunner: () => { throw new Error('No source checkout needed'); } });
  assert.equal(retry.remote.find(item => item.ref === 'stable')?.resumed, true); assert.deepEqual(writes, ['secondary', 'secondary']);
  assert.equal(retry.agents.find(item => item.agent === 'codex')?.failures, undefined);
});

test('explicit repair journals Codex even when the source subscribes only to Claude', async t => {
  const f = fixture(t); f.plugin('demo', '1.0.0'); await addPlugins({ spec: 'example/review', pluginsDir: f.store, all: true, targets: ['claude'], gitRunner: f.clone, agents: [] });
  const { getAgent, registerAgent } = await import('../src/agents/index.ts'); const { discoverPendingMigrations } = await import('../src/migration-transaction.ts');
  const originalClaude = getAgent('claude')!; const originalCodex = getAgent('codex')!;
  t.after(() => { registerAgent(originalClaude); registerAgent(originalCodex); });
  const make = (id: string): Agent => ({ id, displayName: id, adaptTarget: id === 'codex' ? 'codex' : 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'demo', name: 'demo', installed: true, enabled: true, version: '1.0.0' }],
    activate: ctx => ({ agent: id, affected: ctx.plugins, skipped: false }),
    refresh: ctx => id === 'claude' ? { agent: id, affected: [], skipped: false, failures: [{ stage: 'install', errorType: 'TEST', message: 'Claude unavailable' }] } : { agent: id, affected: ctx.plugins, skipped: false },
    deactivate: () => { throw new Error('No retirement'); } });
  registerAgent(make('claude')); registerAgent(make('codex')); f.plugin('demo', '2.0.0');
  const result = await updatePlugins({ pluginsDir: f.store, targets: ['claude'], activate: true, repair: true, gitRunner: f.clone, revisionResolver: () => 'revision-two' });
  assert.ok(result.remote[0]?.pendingRuntime?.length);
  const receipt = JSON.parse(readFileSync(discoverPendingMigrations(f.store)[0]!.journalPath, 'utf8'));
  assert.ok(receipt.operations.some((op: { agent: string; plugin: string }) => op.agent === 'codex' && op.plugin === 'demo'));
});


test('persisted runtime ownership survives an empty provider injection without retirement', async t => {
  const f = fixture(t); f.plugin('former', '1.0.0');
  await addPlugins({ spec: 'example/review', pluginsDir: f.store, all: true, gitRunner: f.clone, agents: [] });
  const lock = readLock(lockPath(f.store)); lock.plugins.former!.runtimeStates = { codex: true }; writeLock(lockPath(f.store), lock);
  rmSync(join(f.remote, 'former'), { recursive: true }); f.plugin('next', '2.0.0');
  mkdirSync(join(f.remote, '.agents'), { recursive: true }); writeFileSync(join(f.remote, '.agents', '.marketplace.json'), JSON.stringify({ name: 'review', renames: { former: 'next' }, plugins: [{ name: 'next', source: './next' }] }));
  const result = await updatePlugins({ pluginsDir: f.store, agents: [], activate: false, gitRunner: f.clone, revisionResolver: () => 'revision-two' });
  assert.ok(result.remote[0]?.pendingRuntime?.length); assert.ok(readLock(lockPath(f.store)).plugins.former);
  const replay = await updatePlugins({ pluginsDir: f.store, agents: [], activate: false, revisionResolver: () => { throw new Error('Must replay offline'); } });
  assert.ok(replay.remote[0]?.pendingRuntime?.length); assert.ok(readLock(lockPath(f.store)).plugins.former);
});
