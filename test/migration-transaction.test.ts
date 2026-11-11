import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMigrationTransaction, publishMigrationTransaction, discoverPendingMigrations } from '../src/migration-transaction.ts';
import { withStoreMutex } from '../src/store-mutex.ts';
import { emptyLock } from '../src/lock.ts';
import type { Agent } from '../src/agents/types.ts';
import type { LockEntry } from '../src/types.ts';

function fixture() {
 const root=mkdtempSync(join(tmpdir(),'adg-transaction-')); const live=join(root,'live'); const stage=join(root,'stage');
 process.env.ADG_MIGRATION_HOME=join(root,'state');process.env.ADG_CACHE_HOME=join(root,'system-cache');process.env.ADG_MUTEX_HOME=join(root,'mutex');
 mkdirSync(live); mkdirSync(join(stage,'.agents'),{recursive:true});
 writeFileSync(join(stage,'.agents','.plugin.json'),JSON.stringify({schemaVersion:'adg.plugin/v1',name:'next',version:'1.0.0',description:'Synthetic'}));
 const entry:LockEntry={origin:{type:'local',path:stage},version:'1.0.0',sourceHash:'sha256-a',installedHash:'sha256-b',installedAt:'now',updatedAt:'now'};
 const lock=emptyLock(); lock.plugins.old={...entry,origin:{type:'local',path:'old'}};lock.plugins.unrelated={...entry,state:'disabled'};
 writeFileSync(join(live,'.plugin-lock.json'),JSON.stringify(lock));mkdirSync(join(live,'old'));
 return {root,live,stage,entry};
}

test('migration retains predecessor until target succeeds, replays offline, preserves unrelated disabled entry',async()=>{
 const f=fixture();let fail=true;let installs=0;let removes=0;
 const agent:Agent={id:'fake',displayName:'Fake',adaptTarget:'claude',detect:()=>true,available:()=>true,
 activate:()=>{installs++;return {agent:'fake',affected:fail?[]:['next'],skipped:false,...(fail?{failures:[{stage:'install' as const,errorType:'test',message:'retry'}]}:{})};},
 refresh:()=>({agent:'fake',affected:['next'],skipped:false}),deactivate:()=>{removes++;return {agent:'fake',affected:['old'],skipped:false};}};
 try {
 const journal=await prepareMigrationTransaction({pluginsDir:f.live,source:'(local)',revision:'fixed',prepared:[{name:'next',dir:f.stage,entry:f.entry}],retire:['old'],scope:'project',targets:[agent]});
 rmSync(f.stage,{recursive:true});
 assert.equal((await publishMigrationTransaction(journal,{targets:[agent]})).complete,false);
 assert.ok(JSON.parse(readFileSync(join(f.live,'.plugin-lock.json'),'utf8')).plugins.old);assert.equal(removes,0);
 assert.equal(discoverPendingMigrations(f.live).length,1);fail=false;
 assert.equal((await publishMigrationTransaction(journal,{targets:[agent]})).complete,true);
 const lock=JSON.parse(readFileSync(join(f.live,'.plugin-lock.json'),'utf8'));assert.equal(lock.plugins.old,undefined);assert.equal(lock.plugins.unrelated.state,'disabled');assert.equal(removes,1);
 await publishMigrationTransaction(journal,{targets:[agent]});assert.equal(installs,2);assert.equal(removes,1);assert.ok(existsSync(join(f.live,'next')));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('store mutex serializes callers and allows nested operations',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adg-mutex-'));const order:number[]=[];
 try {await Promise.all([withStoreMutex(root,async()=>{order.push(1);await new Promise(r=>setTimeout(r,20));await withStoreMutex(root,()=>order.push(2));}),withStoreMutex(root,()=>order.push(3))]);assert.deepEqual(order,[1,2,3]);}finally{rmSync(root,{recursive:true,force:true});}
});

test('rejects project-controlled journals and manipulated destinations',async()=>{
 const f=fixture();
 try {
 await assert.rejects(publishMigrationTransaction(join(f.live,'journal.json')),/Untrusted/);
 const path=await prepareMigrationTransaction({pluginsDir:f.live,source:'(local)',revision:'fixed',prepared:[{name:'next',dir:f.stage,entry:f.entry}],retire:['old'],scope:'project'});
 const journal=JSON.parse(readFileSync(path,'utf8'));journal.prepared[0].dest=join(f.root,'outside');writeFileSync(path,JSON.stringify(journal));
 await assert.rejects(publishMigrationTransaction(path),/destination mismatch/);assert.equal(existsSync(join(f.root,'outside')),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('resumes after payload publication fails before metadata, retaining predecessor',async()=>{
 const f=fixture();
 try {
 const path=await prepareMigrationTransaction({pluginsDir:f.live,source:'(local)',revision:'fixed',prepared:[{name:'next',dir:f.stage,entry:f.entry}],retire:['old'],scope:'project'});
 mkdirSync(join(f.live,'marketplace.json'));
 await assert.rejects(publishMigrationTransaction(path));assert.ok(existsSync(join(f.live,'old')));assert.ok(existsSync(join(f.live,'next')));
 rmSync(join(f.live,'marketplace.json'),{recursive:true});
 assert.equal((await publishMigrationTransaction(path)).complete,true);
 assert.equal(existsSync(join(path,'..','payload')),false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('required target becoming unavailable or interrupted refresh cannot retire predecessors',async()=>{
 const f=fixture();let available=false;let refreshed=0;
 const agent:Agent={id:'fake',displayName:'Fake',adaptTarget:'claude',detect:()=>true,available:()=>available,activate:()=>({agent:'fake',affected:['next'],skipped:false}),refresh:()=>{refreshed++;return {agent:'fake',affected:['next'],skipped:false};},deactivate:()=>({agent:'fake',affected:['old'],skipped:false})};
 try {
 const path=await prepareMigrationTransaction({pluginsDir:f.live,source:'(local)',revision:'fixed',prepared:[{name:'next',dir:f.stage,entry:f.entry}],retire:['old'],scope:'project',targets:[agent]});
 assert.equal((await publishMigrationTransaction(path,{targets:[agent]})).complete,false);
 const journal=JSON.parse(readFileSync(path,'utf8'));journal.operations[0].kind='refresh';journal.operations[0].started=true;writeFileSync(path,JSON.stringify(journal));available=true;
 assert.equal((await publishMigrationTransaction(path,{targets:[agent]})).complete,false);assert.equal(refreshed,0);assert.ok(existsSync(join(f.live,'old')));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('offline staging prepares final runtime paths for an absent target', async () => {
  const f = fixture();
  const agent: Agent = {
    id: 'absent', displayName: 'Absent', adaptTarget: 'antigravity', detect: () => false, available: () => false,
    activate: () => { throw new Error('Must not activate absent target'); },
    refresh: () => { throw new Error('Must not refresh absent target'); },
    deactivate: () => { throw new Error('Must not remove absent target'); },
  };
  try {
    writeFileSync(join(f.stage, '.agents', '.plugin.json'), JSON.stringify({
      schemaVersion: 'adg.plugin/v1', name: 'next', version: '1.0.0', description: 'Synthetic hooks', hooks: './hooks/',
    }));
    mkdirSync(join(f.stage, 'hooks'));
    writeFileSync(join(f.stage, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf synthetic' }] }] } }));
    const journal = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }],
      retire: ['old'], scope: 'project', targets: [agent],
    });
    assert.equal((await publishMigrationTransaction(journal)).complete, true);
    const projected = JSON.parse(readFileSync(join(f.live, 'next', 'hooks.json'), 'utf8')) as {
      next: { PreInvocation: Array<{ command: string }> };
    };
    assert.equal(projected.next.PreInvocation.length, 1);
    const command = projected.next.PreInvocation[0]!.command;
    assert.ok(command.includes(join(f.live, 'next', '.antigravity-plugin', 'hook-runner.mjs')));
    assert.equal(command.includes(f.stage), false);
    assert.equal(command.includes(join(f.root, 'state')), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('fences v5 clients before any visible payload mutation', async () => {
  const f = fixture();
  try {
    const lockPath = join(f.live, '.plugin-lock.json');
    const before = JSON.parse(readFileSync(lockPath, 'utf8'));
    before.version = 5;
    writeFileSync(lockPath, JSON.stringify(before));
    const journal = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project',
    });
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).version, 5);
    rmSync(join(journal, '..', 'payload', '0'), { recursive: true });
    await assert.rejects(publishMigrationTransaction(journal));
    const fenced = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(fenced.version, 6);
    assert.ok(fenced.plugins.old);
    assert.equal(existsSync(join(f.live, 'next')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects retired or replaced names owned by another source/ref', async () => {
  const f = fixture();
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
    lock.plugins.old.origin = { type: 'github', repo: 'synthetic/foreign', ref: 'other' };
    writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    await assert.rejects(prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project',
    }), /source\/ref does not own/);
    assert.ok(existsSync(join(f.live, 'old')));
    assert.equal(discoverPendingMigrations(f.live).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('disabled same-name successor removes active native registration before completion', async () => {
  const f = fixture();
  let removes = 0;
  const agent: Agent = {
    id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'old', name: 'old', installed: true, enabled: true }],
    activate: () => { throw new Error('Must not activate disabled successor'); },
    refresh: () => { throw new Error('Must not refresh disabled successor'); },
    deactivate: () => { removes++; return { agent: 'fake', affected: ['old'], skipped: false }; },
  };
  try {
    const manifest = JSON.parse(readFileSync(join(f.stage, '.agents', '.plugin.json'), 'utf8'));
    manifest.name = 'old'; writeFileSync(join(f.stage, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const journal = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'old', dir: f.stage, entry: { ...f.entry, state: 'disabled' } }], retire: [], scope: 'project', targets: [agent],
    });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
    assert.equal(removes, 1);
    assert.equal(JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')).plugins.old.state, 'disabled');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('declared safe refresh retry converges after same-version interruption', async () => {
  const f = fixture(); let refreshes = 0;
  const agent: Agent = {
    id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true, retrySafeOperations: ['refresh'],
    inspectPlugins: () => [{ id: 'old', name: 'old', installed: true, enabled: true, version: '1.0.0' }],
    activate: () => { throw new Error('Must refresh existing native entry'); },
    refresh: () => { refreshes++; return { agent: 'fake', affected: ['old'], skipped: false }; },
    deactivate: () => ({ agent: 'fake', affected: [], skipped: false }),
  };
  try {
    const manifest = JSON.parse(readFileSync(join(f.stage, '.agents', '.plugin.json'), 'utf8'));
    manifest.name = 'old'; writeFileSync(join(f.stage, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const journal = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'old', dir: f.stage, entry: f.entry }], retire: [], scope: 'project', targets: [agent],
    });
    const record = JSON.parse(readFileSync(journal, 'utf8')); record.operations[0].started = true; writeFileSync(journal, JSON.stringify(record));
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
    assert.equal(refreshes, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('independent source publishes while unavailable peer remains pending, preserving newer live rows', async () => {
  const f = fixture();
  const unavailable: Agent = {
    id: 'offline', displayName: 'Offline', adaptTarget: 'claude', detect: () => true, available: () => false,
    activate: () => { throw new Error('Unavailable'); }, refresh: () => { throw new Error('Unavailable'); }, deactivate: () => { throw new Error('Unavailable'); },
  };
  try {
    const a = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed-a', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [unavailable],
    });
    assert.equal((await publishMigrationTransaction(a, { targets: [unavailable] })).complete, false);
    const foreignEntry: LockEntry = { ...f.entry, origin: { type: 'github', repo: 'synthetic/independent', ref: 'main' } };
    const manifest = JSON.parse(readFileSync(join(f.stage, '.agents', '.plugin.json'), 'utf8'));
    manifest.name = 'peer'; writeFileSync(join(f.stage, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const b = await prepareMigrationTransaction({
      pluginsDir: f.live, source: 'synthetic/independent', ref: 'main', revision: 'fixed-b', prepared: [{ name: 'peer', dir: f.stage, entry: foreignEntry }], retire: [], scope: 'project',
    });
    assert.equal((await publishMigrationTransaction(b)).complete, true);
    // Replay A's pending native step after B has written a newer live plugin row.
    assert.equal((await publishMigrationTransaction(a, { targets: [unavailable] })).complete, false);
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
    assert.ok(lock.plugins.peer);
    assert.ok(lock.plugins.old);
    const marketplace = JSON.parse(readFileSync(join(f.live, 'marketplace.json'), 'utf8'));
    assert.ok(marketplace.plugins.some((p: { name: string }) => p.name === 'peer'));
    assert.equal(discoverPendingMigrations(f.live).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('queues unchanged survivor repair only for requested target, deduped before retirement', async () => {
  const f = fixture();
  const calls: string[] = [];
  const makeAgent = (id: string): Agent => ({
    id, displayName: id, adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: (ctx) => { calls.push(`${id}:activate:${ctx.plugins[0]}`); return { agent: id, affected: ctx.plugins, skipped: false }; },
    refresh: (ctx) => { calls.push(`${id}:refresh:${ctx.plugins[0]}`); return { agent: id, affected: ctx.plugins, skipped: false }; },
    deactivate: (ctx) => { calls.push(`${id}:retire:${ctx.plugins[0]}`); return { agent: id, affected: ctx.plugins, skipped: false }; },
  });
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
    lock.plugins.peer = { ...f.entry };
    writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const targets = [makeAgent('first'), makeAgent('second')];
    const path = await prepareMigrationTransaction({
      pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }],
      retire: ['old'], scope: 'project', targets, refreshExisting: [{ name: 'peer', target: 'first' }, { name: 'peer', target: 'first' }],
    });
    assert.equal((await publishMigrationTransaction(path, { targets })).complete, true);
    assert.equal(calls.filter((call) => call === 'first:refresh:peer').length, 1);
    assert.equal(calls.includes('second:refresh:peer'), false);
    assert.ok(calls.indexOf('first:refresh:peer') < calls.indexOf('first:retire:old'));
    assert.ok(calls.indexOf('first:refresh:peer') < calls.indexOf('second:retire:old'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('first activation interrupted before native install resumes after proven absence', async () => {
  const f = fixture(); let calls = 0; let present = false;
  const agent: Agent = { id: 'claude-like', displayName: 'Claude-like', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => present ? [{ id: 'next', name: 'next', installed: true, enabled: true, version: '1.0.0' }] : [],
    activate: ctx => { calls++; if (calls === 1) throw new Error('interrupted before first install'); present = true; return { agent: 'claude-like', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unexpected refresh'); }, deactivate: ctx => ({ agent: 'claude-like', affected: ctx.plugins, skipped: false }) };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: [], scope: 'project', targets: [agent] });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, false);
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
    assert.equal(calls, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('completed receipt survives deletion of the original lexical store alias', async () => {
  const f = fixture(); const { symlinkSync } = await import('node:fs'); const alias = join(f.root, 'alias');
  try {
    symlinkSync(f.live, alias, 'dir');
    const journal = await prepareMigrationTransaction({ pluginsDir: alias, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: [], scope: 'project' });
    assert.equal((await publishMigrationTransaction(journal)).complete, true);
    rmSync(alias);
    assert.deepEqual(discoverPendingMigrations(f.live), []);
    assert.equal((await publishMigrationTransaction(journal)).complete, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('unchanged successor is repaired and verified on each predecessor target before retirement', async () => {
  const f = fixture(); const calls: string[] = []; const native = new Map([['old', { enabled: true, version: '1.0.0' }]]);
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [...native].map(([name, state]) => ({ id: name, name, installed: true, ...state })),
    activate: ctx => { calls.push(`activate:${ctx.plugins[0]}`); native.set(ctx.plugins[0]!, { enabled: true, version: '1.0.0' }); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: ctx => { calls.push(`refresh:${ctx.plugins[0]}`); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    deactivate: ctx => { calls.push(`retire:${ctx.plugins[0]}`); native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.next = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [], retire: ['old'], scope: 'project', targets: [agent], ...{ successors: [{ name: 'next', predecessors: ['old'] }] } });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
    assert.deepEqual(calls, ['activate:next', 'retire:old']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rename carries a predecessor native-disabled override to its new successor', async () => {
  const f = fixture(); let activations = 0; let retired = false;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => retired ? [] : [{ id: 'old', name: 'old', installed: true, enabled: false, version: '1.0.0' }],
    activate: ctx => { activations++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unexpected refresh'); }, deactivate: ctx => { retired = true; return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], ...{ successors: [{ name: 'next', predecessors: ['old'] }] } });
    const published = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(published.complete, true);
    assert.deepEqual(published.agents?.[0]?.preservedDisabled, ['next']);
    assert.deepEqual(published.agents?.[0]?.affected, []);
    assert.equal(activations, 0); assert.equal(retired, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('retirement covers a later linked target outside the original subscription', async () => {
  const f = fixture(); const removed: string[] = [];
  const provider = (id: string): Agent => { const native = new Set(['old']); return { id, displayName: id, adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [...native].map(name => ({ id: name, name, installed: true, enabled: true, version: '1.0.0' })),
    activate: ctx => { native.add(ctx.plugins[0]!); return { agent: id, affected: ctx.plugins, skipped: false }; },
    refresh: ctx => ({ agent: id, affected: ctx.plugins, skipped: false }),
    deactivate: ctx => { removed.push(id); native.delete(ctx.plugins[0]!); return { agent: id, affected: ctx.plugins, skipped: false }; } }; };
  const primary = provider('primary'); const later = provider('later');
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [primary], ...{ retireTargets: [primary, later], successors: [{ name: 'next', predecessors: ['old'] }] } });
    assert.equal((await publishMigrationTransaction(journal, { targets: [primary, later] })).complete, true);
    assert.deepEqual(removed.sort(), ['later', 'primary']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('split inherits a disabled predecessor on every child without widening native activation', async () => {
  const f = fixture(); const { cpSync } = await import('node:fs'); const second = join(f.root, 'second'); let activated = 0; let retired = false;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => retired ? [] : [{ id: 'old', name: 'old', installed: true, enabled: false, version: '1.0.0' }],
    activate: ctx => { activated++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; }, refresh: () => { throw new Error('Unexpected refresh'); },
    deactivate: ctx => { retired = true; return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    cpSync(f.stage, second, { recursive: true }); const manifest = JSON.parse(readFileSync(join(second, '.agents', '.plugin.json'), 'utf8')); manifest.name = 'second'; writeFileSync(join(second, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }, { name: 'second', dir: second, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'] }, { name: 'second', predecessors: ['old'] }] });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true); assert.equal(activated, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('mixed predecessor runtime state holds retirement for an explicit successor decision', async () => {
  const f = fixture(); let retired = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'old', name: 'old', installed: true, enabled: true }, { id: 'peer', name: 'peer', installed: true, enabled: false }],
    activate: () => { throw new Error('Must resolve mixed state first'); }, refresh: () => { throw new Error('Unexpected refresh'); },
    deactivate: ctx => { retired++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.peer = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old', 'peer'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old', 'peer'] }] });
    const result = await publishMigrationTransaction(journal, { targets: [agent] }); assert.equal(result.complete, false); assert.match(result.failures[0]!.message, /mixed enabled\/disabled/); assert.equal(retired, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('independently enabled existing successor is not disabled by a disabled predecessor', async () => {
  const f = fixture(); const native = new Map([['old', false], ['next', true]]); const removed: string[] = [];
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [...native].map(([name, enabled]) => ({ id: name, name, enabled, installed: true, version: '1.0.0' })),
    activate: () => { throw new Error('Already enabled'); }, refresh: () => { throw new Error('Already current'); },
    deactivate: ctx => { removed.push(ctx.plugins[0]!); native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.next = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'] }] });
    const published = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(published.complete, true); assert.deepEqual(removed, ['old']); assert.equal(native.get('next'), true);
    assert.deepEqual(published.agents?.[0]?.verified, ['next']);
    assert.deepEqual(published.agents?.[0]?.affected, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('source/cache-only prepared entry avoids native refresh and unrelated retirement providers', async () => {
  const f = fixture(); let calls = 0;
  const agent: Agent = { id: 'primary', displayName: 'Primary', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: () => { calls++; throw new Error('No effective payload change'); }, refresh: () => { calls++; throw new Error('No effective payload change'); }, deactivate: () => { throw new Error('No retirement'); } };
  const unrelated: Agent = { ...agent, id: 'unrelated', detect: () => { throw new Error('Do not widen targets without retirement'); } };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry, runtimeRefreshRequired: false }], retire: [], scope: 'project', targets: [agent], retireTargets: [unrelated] });
    const published = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(published.complete, true); assert.equal(calls, 0); assert.deepEqual(published.agents, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('publication reports merged native successes without counting retired identities', async () => {
  const f = fixture(); const { cpSync } = await import('node:fs'); const second = join(f.root, 'second');
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: ctx => ({ agent: 'fake', affected: [...ctx.plugins, ...ctx.plugins], verified: ctx.plugins, skipped: false }),
    refresh: ctx => ({ agent: 'fake', affected: ctx.plugins, skipped: false }),
    deactivate: ctx => ({ agent: 'fake', affected: ctx.plugins, verified: ctx.plugins, skipped: false }) };
  try {
    cpSync(f.stage, second, { recursive: true }); const manifest = JSON.parse(readFileSync(join(second, '.agents', '.plugin.json'), 'utf8')); manifest.name = 'second'; writeFileSync(join(second, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }, { name: 'second', dir: second, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent] });
    const result = await publishMigrationTransaction(journal, { targets: [agent] });
    const reports = (result as unknown as { agents?: Array<{ affected: string[]; verified?: string[] }> }).agents;
    assert.deepEqual(reports?.map(item => item.affected), [['next', 'second']]); assert.deepEqual(reports?.[0]?.verified, ['next', 'second']);
    assert.deepEqual((await publishMigrationTransaction(journal, { targets: [agent] }) as unknown as { agents?: unknown[] }).agents, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('publication exposes partial failures and excludes native operations that failed verification', async () => {
  const f = fixture();
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: ctx => ({ agent: 'fake', affected: ctx.plugins, skipped: false }), refresh: ctx => ({ agent: 'fake', affected: ctx.plugins, skipped: false }),
    deactivate: () => { throw new Error('Retirement must wait'); }, listInstalled: () => [] };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent] });
    const result = await publishMigrationTransaction(journal, { targets: [agent] });
    const report = (result as unknown as { agents?: Array<{ affected: string[]; unverified?: string[]; failures?: unknown[] }> }).agents?.[0];
    assert.equal(result.complete, false); assert.deepEqual(report?.affected, []); assert.deepEqual(report?.unverified, ['next']); assert.ok(report?.failures?.length);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const enabled of [true, false]) {
  test(`explicit target state ${enabled ? 'enabled' : 'disabled'} resolves mixed predecessors and replays offline`, async () => {
    const f = fixture(); const native = new Map([['old', true], ['peer', false]]); let mutations = 0; let available = false;
    const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => available,
      inspectPlugins: () => [...native].map(([name, state]) => ({ id: name, name, enabled: state, installed: true, version: '1.0.0' })),
      activate: ctx => { mutations++; native.set(ctx.plugins[0]!, true); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
      refresh: ctx => { mutations++; native.set(ctx.plugins[0]!, true); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
      deactivate: ctx => { mutations++; native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
    try {
      const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.peer = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
      const successors = [{ name: 'next', predecessors: ['old', 'peer'], enabledByTarget: { fake: enabled } }];
      const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old', 'peer'], scope: 'project', targets: [agent], successors });
      assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, false);
      successors[0]!.enabledByTarget.fake = !enabled;
      rmSync(f.stage, { recursive: true });
      available = true;
      const result = await publishMigrationTransaction(journal, { targets: [agent] });
      assert.equal(result.complete, true); assert.equal(native.has('old'), false); assert.equal(native.has('peer'), false); assert.equal(native.get('next') ?? false, enabled);
      const count = mutations;
      const repeated = await publishMigrationTransaction(journal, { targets: [agent] }); assert.equal(repeated.complete, true); assert.deepEqual(repeated.agents, []); assert.equal(mutations, count);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('explicit target state decisions reject malformed values and unauthorized providers before staging', async () => {
  const f = fixture();
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: () => { throw new Error('Validation must run before native work'); }, refresh: () => { throw new Error('Unexpected'); }, deactivate: () => { throw new Error('Unexpected'); } };
  try {
    for (const invalid of [{ fake: 'enabled' }, { unknown: true }, ['fake'], null]) {
      await assert.rejects(prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent],
        successors: [{ name: 'next', predecessors: ['old'], enabledByTarget: invalid as unknown as Record<string, boolean> }] }), /target state decision|plain boolean record/);
      assert.deepEqual(discoverPendingMigrations(f.live), []);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const enabled of [true, false]) {
  test(`explicit target decision can override an independently ${enabled ? 'disabled' : 'enabled'} destination`, async () => {
    const f = fixture(); const native = new Map([['old', !enabled], ['next', !enabled]]);
    const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
      inspectPlugins: () => [...native].map(([name, state]) => ({ id: name, name, enabled: state, installed: true, version: '1.0.0' })),
      activate: () => { throw new Error('Existing disabled identity must use a refresh that preserves user data'); },
      refresh: ctx => { assert.equal(ctx.forceEnable, true); assert.equal(ctx.preserveData, true); native.set(ctx.plugins[0]!, true); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
      deactivate: ctx => { native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
    try {
      const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.next = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
      const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [], retire: ['old'], scope: 'project', targets: [agent],
        successors: [{ name: 'next', predecessors: ['old'], enabledByTarget: { fake: enabled } }] });
      const result = await publishMigrationTransaction(journal, { targets: [agent] });
      assert.equal(result.complete, true); assert.equal(native.get('next') ?? false, enabled); assert.equal(native.has('old'), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('an unavailable target can request mixed-state review on replay and finish with a saved decision', async () => {
  const f = fixture(); let available = false; let activations = 0; const native = new Map([['old', true], ['peer', false]]);
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => available,
    inspectPlugins: () => [...native].map(([name, enabled]) => ({ id: name, name, enabled, installed: true, version: '1.0.0' })),
    activate: ctx => { activations++; assert.equal((ctx as { forceEnable?: boolean }).forceEnable, true); native.set(ctx.plugins[0]!, true); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unexpected refresh'); }, deactivate: ctx => { native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.peer = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old', 'peer'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old', 'peer'] }] });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, false);
    rmSync(f.stage, { recursive: true }); available = true;
    const mixed = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(mixed.complete, false); assert.deepEqual((mixed as unknown as { stateDecisions?: unknown[] }).stateDecisions, [{ agent: 'fake', plugin: 'next' }]); assert.equal(activations, 0);
    const result = await publishMigrationTransaction(journal, { targets: [agent], ...{ stateDecisions: [{ agent: 'fake', plugin: 'next', enabled: true }] } });
    assert.equal(result.complete, true); assert.equal(activations, 1);
    const saved = JSON.parse(readFileSync(journal, 'utf8')); assert.equal(saved.successors[0].enabledByTarget.fake, true); assert.equal(saved.operations[0].successor.enabledByTarget.fake, true);
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true); assert.equal(activations, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('replay state choices cannot add targets or alter unrelated lifecycle operations', async () => {
  const f = fixture();
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    activate: () => { throw new Error('Decision validation must precede native work'); }, refresh: () => { throw new Error('Unexpected'); }, deactivate: () => { throw new Error('Unexpected'); } };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'] }] });
    const before = readFileSync(journal, 'utf8');
    for (const decision of [{ agent: 'other', plugin: 'next', enabled: true }, { agent: 'fake', plugin: 'old', enabled: false }, { agent: 'fake', plugin: 'next', enabled: 'yes' }]) {
      await assert.rejects(publishMigrationTransaction(journal, { targets: [agent], stateDecisions: [decision as unknown as { agent: string; plugin: string; enabled: boolean }] }), /target state decision|pending successor target/);
      assert.equal(readFileSync(journal, 'utf8'), before); assert.equal(existsSync(join(f.live, 'next')), false);
    }
    await assert.rejects(publishMigrationTransaction(journal, { targets: [agent], stateDecisions: [{ agent: 'fake', plugin: 'next', enabled: true }, { agent: 'fake', plugin: 'next', enabled: false }] }), /Conflicting native/);
    assert.equal(readFileSync(journal, 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('interrupted force activation of a newly installed disabled identity resumes through safe refresh', async () => {
  const f = fixture(); const native = new Map([['old', true]]); let activations = 0; let refreshes = 0;
  const agent: Agent = { id: 'claude-like', displayName: 'Claude-like', adaptTarget: 'claude', detect: () => true, available: () => true, retrySafeOperations: ['refresh'],
    inspectPlugins: () => [...native].map(([name, enabled]) => ({ id: name, name, enabled, installed: true, version: '1.0.0' })),
    activate: ctx => { activations++; assert.equal(ctx.forceEnable, true); native.set(ctx.plugins[0]!, false); throw new Error('Interrupted after install before explicit enable'); },
    refresh: ctx => { refreshes++; assert.equal(ctx.forceEnable, true); assert.equal(ctx.preserveData, true); native.set(ctx.plugins[0]!, true); return { agent: 'claude-like', affected: ctx.plugins, verified: ctx.plugins, skipped: false }; },
    deactivate: ctx => { native.delete(ctx.plugins[0]!); return { agent: 'claude-like', affected: ctx.plugins, skipped: false }; } };
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'], enabledByTarget: { 'claude-like': true } }] });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, false);
    assert.equal(native.get('next'), false); assert.equal(native.has('old'), true);
    rmSync(f.stage, { recursive: true });
    const replay = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(replay.complete, true); assert.equal(native.get('next'), true); assert.equal(native.has('old'), false); assert.equal(activations, 1); assert.equal(refreshes, 1);
    assert.deepEqual(replay.agents?.[0]?.verified, ['next']);
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true); assert.equal(refreshes, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('readback-confirmed native mutation stays in verified report alongside an unchanged successor check', async () => {
  const f = fixture(); const native = new Set(['old', 'peer']);
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [...native].map(name => ({ id: name, name, installed: true, enabled: true, version: '1.0.0' })),
    listInstalled: () => [...native],
    activate: ctx => { native.add(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Unchanged successor is already current'); },
    deactivate: ctx => { native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.peer = f.entry; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'peer', predecessors: ['old'] }] });
    const result = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(result.complete, true); assert.deepEqual(result.agents?.[0]?.affected, ['next']); assert.deepEqual(result.agents?.[0]?.verified, ['next', 'peer']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('inherited runtime-disabled intent survives the next ordinary source update', async () => {
  const f = fixture(); let activations = 0; let retired = false;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => retired ? [] : [{ id: 'old', name: 'old', installed: true, enabled: false, version: '1.0.0' }],
    activate: ctx => { activations++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Disabled runtime must remain untouched'); },
    deactivate: ctx => { retired = true; return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
  try {
    const first = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'first', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'] }] });
    assert.equal((await publishMigrationTransaction(first, { targets: [agent] })).complete, true);
    const saved = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
    assert.equal(saved.plugins.next.runtimeStates?.fake, false);
    const manifest = JSON.parse(readFileSync(join(f.stage, '.agents', '.plugin.json'), 'utf8')); manifest.version = '2.0.0'; writeFileSync(join(f.stage, '.agents', '.plugin.json'), JSON.stringify(manifest));
    const second = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'second', prepared: [{ name: 'next', dir: f.stage, entry: { ...f.entry, version: '2.0.0', installedHash: 'sha256-second' } }], retire: [], scope: 'project', targets: [agent] });
    assert.equal((await publishMigrationTransaction(second, { targets: [agent] })).complete, true); assert.equal(activations, 0);
    assert.equal(JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')).plugins.next.runtimeStates.fake, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ordinary update records an independently enabled native identity over stored disabled intent', async () => {
  const f = fixture(); let refreshes = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
    inspectPlugins: () => [{ id: 'next', name: 'next', installed: true, enabled: true, version: '1.0.0' }],
    activate: () => { throw new Error('Already natively installed'); },
    refresh: ctx => { refreshes++; assert.equal(ctx.forceEnable, undefined); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    deactivate: () => { throw new Error('User independently enabled this identity'); } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')); lock.plugins.next = { ...f.entry, runtimeStates: { fake: false } }; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'next', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: [], scope: 'project', targets: [agent] });
    assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true); assert.equal(refreshes, 1);
    assert.equal(JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')).plugins.next.runtimeStates.fake, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const split of [false, true]) {
  test(`${split ? 'successive splits' : 'successive renames'} preserve absent predecessor runtime-disabled intent`, async () => {
    const f = fixture(); const { cpSync } = await import('node:fs'); const native = new Map([['old', false]]); let activations = 0;
    const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true,
      inspectPlugins: () => [...native].map(([name, enabled]) => ({ id: name, name, enabled, installed: true, version: '1.0.0' })),
      activate: ctx => { activations++; native.set(ctx.plugins[0]!, true); return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
      refresh: () => { throw new Error('Disabled runtime must not refresh'); },
      deactivate: ctx => { native.delete(ctx.plugins[0]!); return { agent: 'fake', affected: ctx.plugins, skipped: false }; } };
    const staged = (name: string) => {
      if (name === 'next') return { name, dir: f.stage, entry: f.entry };
      const dir = join(f.root, `${name}-stage`); cpSync(f.stage, dir, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(dir, '.agents', '.plugin.json'), 'utf8')); manifest.name = name; writeFileSync(join(dir, '.agents', '.plugin.json'), JSON.stringify(manifest));
      return { name, dir, entry: f.entry };
    };
    try {
      const initial = split ? ['next', 'retained'] : ['next'];
      const first = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'first', prepared: initial.map(staged), retire: ['old'], scope: 'project', targets: [agent], successors: initial.map(name => ({ name, predecessors: ['old'] })) });
      assert.equal((await publishMigrationTransaction(first, { targets: [agent] })).complete, true); assert.equal(native.size, 0);
      const terminal = split ? ['left', 'right'] : ['final'];
      const second = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'second', prepared: terminal.map(staged), retire: ['next'], scope: 'project', targets: [agent], successors: terminal.map(name => ({ name, predecessors: ['next'] })) });
      assert.equal((await publishMigrationTransaction(second, { targets: [agent] })).complete, true); assert.equal(activations, 0);
      const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
      for (const name of terminal) assert.equal(lock.plugins[name].runtimeStates.fake, false);
      if (split) assert.equal(lock.plugins.retained.runtimeStates.fake, false);
      assert.equal((await publishMigrationTransaction(second, { targets: [agent] })).complete, true); assert.equal(activations, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('absent predecessors with stored mixed runtime intent request a decision before retirement', async () => {
  const f = fixture(); let activations = 0;
  const agent: Agent = { id: 'fake', displayName: 'Fake', adaptTarget: 'claude', detect: () => true, available: () => true, inspectPlugins: () => [],
    activate: ctx => { activations++; return { agent: 'fake', affected: ctx.plugins, skipped: false }; },
    refresh: () => { throw new Error('Nothing is natively installed'); }, deactivate: () => { throw new Error('Absent predecessors require no native removal'); } };
  try {
    const lock = JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8'));
    lock.plugins.old.runtimeStates = { fake: false }; lock.plugins.peer = { ...f.entry, runtimeStates: { fake: true } }; writeFileSync(join(f.live, '.plugin-lock.json'), JSON.stringify(lock));
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'mixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old', 'peer'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old', 'peer'] }] });
    const pending = await publishMigrationTransaction(journal, { targets: [agent] });
    assert.equal(pending.complete, false); assert.deepEqual(pending.stateDecisions, [{ agent: 'fake', plugin: 'next' }]); assert.equal(activations, 0);
    const result = await publishMigrationTransaction(journal, { targets: [agent], stateDecisions: [{ agent: 'fake', plugin: 'next', enabled: false }] });
    assert.equal(result.complete, true); assert.equal(activations, 0);
    assert.equal(JSON.parse(readFileSync(join(f.live, '.plugin-lock.json'), 'utf8')).plugins.next.runtimeStates.fake, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const enabled of [true, false]) {
  test(`native namespace retains lexical store alias for ${enabled ? 'enabled' : 'disabled'} predecessor retirement`, async () => {
    const f = fixture(); const { symlinkSync } = await import('node:fs'); const alias = join(f.root, 'native-alias'); symlinkSync(f.live, alias, 'dir');
    const namespaces = new Map<string, Map<string, boolean>>([[alias, new Map([['old', enabled]])]]); let activations = 0;
    const state = (dir: string) => { let value = namespaces.get(dir); if (!value) { value = new Map(); namespaces.set(dir, value); } return value; };
    const agent: Agent = { id: 'namespaced', displayName: 'Namespaced', adaptTarget: 'claude', detect: () => true, available: () => true,
      inspectPlugins: ctx => [...state(ctx.pluginsDir)].map(([name, active]) => ({ id: name, name, installed: true, enabled: active, version: '1.0.0' })),
      activate: ctx => { activations++; state(ctx.pluginsDir).set(ctx.plugins[0]!, true); return { agent: 'namespaced', affected: ctx.plugins, skipped: false }; },
      refresh: () => { throw new Error('New successor must not refresh'); },
      deactivate: ctx => { state(ctx.pluginsDir).delete(ctx.plugins[0]!); return { agent: 'namespaced', affected: ctx.plugins, skipped: false }; } };
    try {
      const journal = await prepareMigrationTransaction({ pluginsDir: alias, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, entry: f.entry }], retire: ['old'], scope: 'project', targets: [agent], successors: [{ name: 'next', predecessors: ['old'] }] });
      assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
      assert.equal(state(alias).has('old'), false); assert.equal(state(alias).get('next') ?? false, enabled); assert.equal(activations, enabled ? 1 : 0);
      rmSync(alias); assert.deepEqual(discoverPendingMigrations(f.live), []); assert.equal((await publishMigrationTransaction(journal, { targets: [agent] })).complete, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('Windows durability uses writable file handles without changing read-only source files', async t => {
  const f = fixture(); const fs = (await import('node:fs')).default; const { syncBuiltinESMExports } = await import('node:module');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync; const originalFstat = fs.fstatSync; const handles = new Map<number, string | number>();
  const sourceFile = join(f.stage, '.agents', '.plugin.json'); fs.chmodSync(sourceFile, 0o444);
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => { const fd = originalOpen(...args); handles.set(fd, args[1]); return fd; });
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (originalFstat(fd).isFile()) { const flags = handles.get(fd); assert.ok(typeof flags === 'string' && /[wa+]/.test(flags), 'Windows FlushFileBuffers requires a writable file handle'); }
    originalFsync(fd);
  });
  syncBuiltinESMExports(); Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const journal = await prepareMigrationTransaction({ pluginsDir: f.live, source: '(local)', revision: 'fixed', prepared: [{ name: 'next', dir: f.stage, cacheDir: f.stage, entry: f.entry }], retire: [], scope: 'project' });
    assert.equal((await publishMigrationTransaction(journal)).complete, true);
    assert.equal(fs.statSync(sourceFile).mode & 0o777, 0o444);
  } finally {
    Object.defineProperty(process, 'platform', platform); t.mock.restoreAll(); syncBuiltinESMExports(); fs.chmodSync(sourceFile, 0o644); rmSync(f.root, { recursive: true, force: true });
  }
});
