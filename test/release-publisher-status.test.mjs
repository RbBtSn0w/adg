import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepare,publish} from '../scripts/release-payload.mjs';
import {releaseEnv,releaseDecision} from './helpers/release-env.mjs';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
function assertRegistryResult(cwd,operation){
 const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),operation],{cwd,env:{...process.env,RELEASE_ENABLED:'true',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',GITHUB_SHA:'b'.repeat(40),GITHUB_STEP_SUMMARY:'',SEALED_ARTIFACT_ID:''},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(readFileSync(join(cwd,'release-result.json'))),metadata=JSON.parse(readFileSync(join(cwd,'release-input/final.json')));
 for(const [target,registry]of [['npm','https://registry.npmjs.org'],['github-packages','https://npm.pkg.github.com']]){
  const receipt=result.targets[target];assert.equal(receipt.status,'completed');assert.equal(receipt.candidate_sha,metadata.candidate_sha);assert.equal(receipt.version,metadata.version);assert.equal(receipt.sha256,metadata.sha256);assert.equal(receipt.integrity,metadata.integrity);assert.equal(receipt.registry,registry);assert.equal(receipt.remote_id,`${metadata.name}@${metadata.version}`);assert.ok(Number.isFinite(Date.parse(receipt.observed_at)));
 }
}
test('normal publisher readback receipts are confirmed by the actual status adapter for both registries',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'npm-publisher-status-')),root=join(cwd,'release-input/unpacked/package');mkdirSync(root,{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'}));
 const env=releaseEnv(cwd),nextRelease=releaseDecision(cwd,'2.0.0');await prepare({}, {cwd,env,nextRelease});
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path');if(process.argv[2]!=='view')process.exit(99);const metadata=JSON.parse(fs.readFileSync(path.join(process.env.STATE,'release-input/final.json')));console.log(JSON.stringify(process.argv[4]==='dist-tags'?{latest:metadata.version}:metadata.integrity));
`,{mode:0o755});
 await publish({}, {cwd,env:{...env,PATH:bin+':'+env.PATH,STATE:cwd},nextRelease});assertRegistryResult(cwd,'publish');
});
test('original-byte recovery readback receipts are confirmed by the actual status adapter for both registries',()=>{
 const {cwd,result}=runRecovery();assert.equal(result.status,0,result.stderr);assertRegistryResult(cwd,'recover');
});
