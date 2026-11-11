import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mutexUrl = pathToFileURL(join(import.meta.dirname, "../src/store-mutex.ts")).href;
function exercise(scenario: string, ticket: boolean): void {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const scenario = ${JSON.stringify(scenario)};
    const identity = { kind: 'test', version: 1, birthToken: 'current' };
    if(scenario === 'unreadable') Object.defineProperty(process,'platform',{value:'win32'});
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './process-identity.ts') return { url: 'data:text/javascript,' + encodeURIComponent(
        'export const getCurrentProcessIdentity = () => (' + JSON.stringify(identity) + ');' +
        'export const queryProcessIdentity = () => (' + (scenario === 'query-failure' ? 'undefined' : JSON.stringify(identity)) + ');'), shortCircuit: true };
      return next(specifier, context);
    }});
    const root = fs.mkdtempSync(join(tmpdir(), 'adg-identity-'));
    process.env.ADG_MUTEX_HOME = root;
    const contender = join(root, process.pid + '-00000000-0000-0000-0000-000000000000');
    fs.mkdirSync(contender);
    if (scenario !== 'legacy') fs.writeFileSync(join(contender, 'owner.json'), scenario === 'malformed' ? '{}' : JSON.stringify({version:1,pid:process.pid,identity:{...identity,birthToken:scenario === 'matching' ? 'current' : 'old'}}));
    if (${ticket}) fs.writeFileSync(join(contender, 'ticket.json'), '1');
    if(scenario === 'unreadable') {
      const originalRead = fs.readFileSync;
      fs.readFileSync = (path,...args) => {
        if(path === join(contender,'owner.json')) throw Object.assign(new Error('Unreadable owner'),{code:'EACCES'});
        return originalRead(path,...args);
      };
      syncBuiltinESMExports();
    }
    let entered = false;
    try {
      const { withStoreMutex } = await import(${JSON.stringify(mutexUrl)});
      const run = () => withStoreMutex('unused', () => { entered = true; assert.equal(fs.existsSync(contender), false); }, 80);
      if (scenario === 'stale') { await run(); assert.equal(entered,true); }
      else if (scenario === 'malformed') await assert.rejects(run, /Invalid ADG mutation owner/);
      else await assert.rejects(run, /Another ADG mutation is still running/);
      if (scenario !== 'stale') { assert.equal(entered,false); assert.equal(fs.existsSync(contender),true); }
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
for (const ticket of [false, true]) {
  test(`reused live PID is reclaimed ${ticket ? 'with' : 'before'} ticket publication`, () => exercise('stale', ticket));
  for (const scenario of ['matching', 'query-failure', 'legacy', 'malformed', 'unreadable']) {
    test(`${scenario} owner is retained ${ticket ? 'with' : 'without'} a ticket`, () => exercise(scenario, ticket));
  }
}

test("owner is private and complete before atomic publication; unfinished staging stays invisible", () => {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const root = fs.mkdtempSync(join(tmpdir(),'adg-publication-'));
    process.env.ADG_MUTEX_HOME = root;
    const abandoned = join(root,'.preparing-abandoned');
    fs.mkdirSync(abandoned);
    const original = fs.renameSync;
    let published = false;
    fs.renameSync = (source, destination) => {
      if (String(source).includes('.preparing-')) {
        assert.equal(fs.readdirSync(root).filter(name => /^\\d+-[a-f0-9-]{36}$/.test(name)).length,0);
        const owner = JSON.parse(fs.readFileSync(join(source,'owner.json'),'utf8'));
        assert.equal(owner.pid,process.pid);
        assert.ok(owner.identity.birthToken);
        assert.equal(fs.existsSync(join(source,'ticket.json')),false);
        if (process.platform !== 'win32') {
          assert.equal(fs.statSync(source).mode & 0o077,0);
          assert.equal(fs.statSync(join(source,'owner.json')).mode & 0o077,0);
        }
        published = true;
      }
      return original(source,destination);
    };
    syncBuiltinESMExports();
    try {
      const {withStoreMutex} = await import(${JSON.stringify(mutexUrl)});
      await withStoreMutex('unused',()=>assert.equal(published,true));
      assert.deepEqual(fs.readdirSync(root),['.preparing-abandoned']);
    } finally { fs.renameSync = original; syncBuiltinESMExports(); fs.rmSync(root,{recursive:true,force:true}); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("unavailable self identity fails before publishing any contender", () => {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {registerHooks} from 'node:module';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    registerHooks({resolve(specifier,context,next) {
      if(specifier === './process-identity.ts') return {url:'data:text/javascript,'+encodeURIComponent('export function getCurrentProcessIdentity(){throw Error("identity unavailable")} export const queryProcessIdentity=()=>undefined;'),shortCircuit:true};
      return next(specifier,context);
    }});
    const root=fs.mkdtempSync(join(tmpdir(),'adg-unavailable-'));
    process.env.ADG_MUTEX_HOME=root;
    try {
      const {withStoreMutex}=await import(${JSON.stringify(mutexUrl)});
      await assert.rejects(()=>withStoreMutex('unused',()=>assert.fail('must not enter')),/identity unavailable/);
      assert.deepEqual(fs.readdirSync(root),[]);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `;
  const result=spawnSync(process.execPath,["--input-type=module","-e",program],{encoding:"utf8",timeout:5000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
});

function probeContention(scenario: "many" | "nonblocking" | "changed"): void {
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {registerHooks,syncBuiltinESMExports} from 'node:module';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    const scenario=${JSON.stringify(scenario)};
    globalThis.identityProbes=0;
    const identity={kind:'test',version:1,birthToken:'original'};
    registerHooks({resolve(specifier,context,next) {
      if(specifier==='./process-identity.ts') return {url:'data:text/javascript,'+encodeURIComponent(
        'export const getCurrentProcessIdentity=()=>('+JSON.stringify(identity)+');'+
        'export function queryProcessIdentity(){globalThis.identityProbes++; return {...getCurrentProcessIdentity(),birthToken:'+ (scenario==='changed' ? '(globalThis.identityProbes===1 ? "original" : "changed")' : '"original"') +'};}'),shortCircuit:true};
      return next(specifier,context);
    }});
    const root=fs.mkdtempSync(join(tmpdir(),'adg-probe-contention-'));
    process.env.ADG_MUTEX_HOME=root;
    const add=(index,ticket)=>{
      const name=process.pid+'-'+String(index).padStart(8,'0')+'-0000-0000-0000-000000000000';
      const path=join(root,name);fs.mkdirSync(path);
      fs.writeFileSync(join(path,'owner.json'),JSON.stringify({version:1,pid:process.pid,identity}));
      fs.writeFileSync(join(path,'ticket.json'),String(ticket));
    };
    if(scenario!=='nonblocking') for(let index=0;index<(scenario==='many'?20:1);index++) add(index,index+1);
    const originalRename=fs.renameSync;
    fs.renameSync=(source,destination)=>{
      originalRename(source,destination);
      if(scenario==='nonblocking' && String(destination).endsWith('ticket.json')) for(let index=0;index<20;index++) add(index,100+index);
    };
    syncBuiltinESMExports();
    if(scenario==='changed') {
      let now=0; Date.now=()=>now;
      const originalTimeout=globalThis.setTimeout;
      globalThis.setTimeout=(callback,delay,...args)=>{now+=1000; return originalTimeout(callback,delay,...args);};
    }
    try {
      const {withStoreMutex}=await import(${JSON.stringify(mutexUrl)});
      const run=()=>withStoreMutex('unused',()=>{},scenario==='changed'?10000:80);
      if(scenario==='many') {await assert.rejects(run,/Another ADG mutation is still running/);assert.equal(globalThis.identityProbes,1,'Only the first actual blocker should be probed, once within the cache interval');}
      else if(scenario==='nonblocking') {await run(); assert.equal(globalThis.identityProbes,0,'Later tickets must not launch identity queries');}
      else {await run(); assert.equal(globalThis.identityProbes,2,'Matching identities must be revalidated and reused PID records recovered');}
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  `;
  const result=spawnSync(process.execPath,["--input-type=module","-e",program],{encoding:"utf8",timeout:5000});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
}
for(const scenario of ["many","nonblocking","changed"] as const) {
  test(`birth queries are bounded for ${scenario} contention`,()=>probeContention(scenario));
}
