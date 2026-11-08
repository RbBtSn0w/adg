import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoveryTag,cleanRecoveryTag,reconcileLatest} from '../.github/release-train/npm-recovery-tag.mjs';
test('safe recovery observes same or newer latest and retains owned tags without distribution-tag writes',()=>{
 for(const latest of ['1.0.0','2.0.0','9.0.0',undefined]){
  const cwd=mkdtempSync(join(tmpdir(),'npm-safe-recovery-tags-')),bin=join(cwd,'bin');mkdirSync(bin);
  const before={...(latest?{latest}:{}),'recovery-12':'2.0.0',unrelated:'1.0.0'};writeFileSync(join(cwd,'tags.json'),JSON.stringify(before));
  writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);if(args[0]==='view'){console.log(fs.readFileSync(path.join(process.env.STATE,'tags.json'),'utf8'));process.exit(0);}fs.writeFileSync(path.join(process.env.STATE,'mutation-attempt'),JSON.stringify(args));process.exit(98);
`,{mode:0o755});
  const options={cwd,registry:'https://registry.npmjs.org',env:{...process.env,STATE:cwd,PATH:bin+':'+process.env.PATH}},metadata={name:'@scope/public-fixture',version:'2.0.0',source_run_id:'12'};
  const tag=recoveryTag(metadata,options);assert.equal(tag,'recovery-12');
  if(latest==='2.0.0'||latest==='9.0.0')assert.equal(reconcileLatest(metadata,options),latest);else assert.throws(()=>reconcileLatest(metadata,options),/latest|channel|older|unverifiable/i);
  assert.equal(cleanRecoveryTag(metadata,tag,options),false);assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tags.json'))),before);assert.equal(existsSync(join(cwd,'mutation-attempt')),false);
  writeFileSync(join(cwd,'tags.json'),JSON.stringify({latest:'9.0.0','recovery-12':'3.0.0'}));assert.equal(cleanRecoveryTag(metadata,tag,options),false);assert.throws(()=>recoveryTag(metadata,options),/another version/);
 }
});
