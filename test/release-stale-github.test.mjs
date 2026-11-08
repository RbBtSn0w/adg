import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
test('same-workspace GitHub reconciliation invalidates its old completed receipt before failed readback',()=>{
 const {cwd,result}=runRecovery();assert.equal(result.status,0,result.stderr);const receipt=join(cwd,'release-input/receipts/github-release.json');assert.equal(existsSync(receipt),true);
 const script=`import {readFileSync} from 'node:fs';import {reconcileGitHub} from ${JSON.stringify(resolve('scripts/release-recover.mjs'))};reconcileGitHub(JSON.parse(readFileSync('release-input/final.json')),JSON.parse(readFileSync('release-input/analysis.json')).notes);`;
 const retry=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,STATE:cwd,REMOTE_MODE:'read-error',RELEASE_ENABLED:'true'},encoding:'utf8'});assert.notEqual(retry.status,0);assert.equal(existsSync(receipt),false);
});
test('early failed recovery also invalidates stale GitHub completion before its preflight',()=>{
 const {cwd,result}=runRecovery('stale-github-read-error');assert.notEqual(result.status,0);assert.equal(existsSync(join(cwd,'release-input/receipts/github-release.json')),false);
 const status=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'recover'],{cwd,env:{...process.env,RELEASE_ENABLED:'true',PUBLISH_OUTCOME:'failure',GITHUB_SHA:'b'.repeat(40),GITHUB_STEP_SUMMARY:''},encoding:'utf8'});assert.equal(status.status,0,status.stderr);assert.notEqual(JSON.parse(readFileSync(join(cwd,'release-result.json'))).targets['github-release'].status,'completed');
});

test('failed original-source or GitHub preflight invalidates all current target receipts without deleting original artifacts',()=>{
 for(const mode of ['stale-source-read-error','stale-github-read-error']){
  const {cwd,result,original}=runRecovery(mode);assert.notEqual(result.status,0,mode);
  const status=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'recover'],{cwd,env:{...process.env,RELEASE_ENABLED:'true',PUBLISH_OUTCOME:'failure',GITHUB_SHA:'b'.repeat(40),GITHUB_STEP_SUMMARY:''},encoding:'utf8'});assert.equal(status.status,0,status.stderr);const observed=JSON.parse(readFileSync(join(cwd,'release-result.json')));
  for(const target of ['npm','github-packages','github-release'])assert.notEqual(observed.targets[target].status,'completed',`${mode}: ${target}`);
  assert.equal(existsSync(join(cwd,'release-input/receipts/future-target.json')),false);assert.equal(existsSync(join(cwd,'original.zip')),true);assert.deepEqual(readFileSync(join(cwd,'sealed/final.tgz')),original);assert.deepEqual(readFileSync(join(cwd,'release-input/final.tgz')),original);
 }
});
