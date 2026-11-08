import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoveryTag,cleanRecoveryTag,reconcileLatest} from '../.github/release-train/npm-recovery-tag.mjs';
test('recovery restores older/missing latest, retains equal/newer latest and cleans only its own tag',()=>{
 for(const latest of ['1.0.0','2.0.0','9.0.0',undefined]){
  const cwd=mkdtempSync(join(tmpdir(),'npm-recovery-tags-'));const bin=join(cwd,'bin');mkdirSync(bin);
  writeFileSync(join(cwd,'tags.json'),JSON.stringify({...(latest?{latest}:{}),'recovery-12':'2.0.0','unrelated':'1.0.0'}));
  writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path');const file=path.join(process.env.STATE,'tags.json'),args=process.argv.slice(2),tags=JSON.parse(fs.readFileSync(file));
if(args[0]==='view'){console.log(JSON.stringify(tags));process.exit(0);}
fs.appendFileSync(path.join(process.env.STATE,'mutations.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='dist-tag'&&args[1]==='add'){if(args[3]!=='latest')process.exit(97);tags.latest='2.0.0';}
else if(args[0]==='dist-tag'&&args[1]==='rm'){if(args[3]!=='recovery-12')process.exit(98);delete tags[args[3]];}
else process.exit(99);fs.writeFileSync(file,JSON.stringify(tags));
`,{mode:0o755});
  const options={cwd,registry:'https://registry.npmjs.org',env:{...process.env,STATE:cwd,PATH:bin+':'+process.env.PATH}},metadata={name:'@scope/public-fixture',version:'2.0.0',source_run_id:'12'};
  const tag=recoveryTag(metadata,options);assert.equal(tag,'recovery-12');
  assert.equal(reconcileLatest(metadata,options),latest==='9.0.0'?'9.0.0':'2.0.0');
  cleanRecoveryTag(metadata,tag,options);
  const observed=JSON.parse(readFileSync(join(cwd,'tags.json')));assert.equal(observed.latest,latest==='9.0.0'?'9.0.0':'2.0.0');assert.equal(observed.unrelated,'1.0.0');assert.equal(observed['recovery-12'],undefined);
  const mutations=readFileSync(join(cwd,'mutations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(mutations.filter(args=>args[1]==='add').length,!latest||latest==='1.0.0'?1:0);
  writeFileSync(join(cwd,'tags.json'),JSON.stringify({latest:'9.0.0','recovery-12':'3.0.0'}));
  assert.equal(cleanRecoveryTag(metadata,tag,options),false);assert.equal(JSON.parse(readFileSync(join(cwd,'tags.json')))['recovery-12'],'3.0.0');
  assert.throws(()=>recoveryTag(metadata,options),/another version/);
  writeFileSync(join(cwd,'tags.json'),JSON.stringify({latest:'unverifiable'}));
  assert.throws(()=>reconcileLatest(metadata,options),/unverifiable/);
 }
});
