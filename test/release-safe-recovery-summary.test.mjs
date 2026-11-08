import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
test('unconfirmed latest retains byte evidence and never advertises a recovery command that can repair the channel',()=>{
 for(const mode of ['channel-older','channel-missing']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0);
  const env={...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,STATE:cwd,REMOTE_MODE:mode,GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'99',GITHUB_REPOSITORY:'owner/repo',RELEASE_ENABLED:'true',PUBLISH_OUTCOME:'failure',GITHUB_STEP_SUMMARY:join(cwd,'summary.md'),FINAL_OPERATION:'recover',FINAL_RECOVER_RESULT:'failure',SOURCE_RUN_ID:'12',ARTIFACT_ID:'34'};
  const status=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'recover'],{cwd,env,encoding:'utf8'});assert.equal(status.status,0,status.stderr);mkdirSync(join(cwd,'release-observations'));cpSync(join(cwd,'release-result.json'),join(cwd,'release-observations/release-result.json'));
  const final=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env,encoding:'utf8'});assert.equal(final.status,1,final.stderr);
  const observed=JSON.parse(readFileSync(join(cwd,'release-result.json')));assert.notEqual(observed.publication,'completed');assert.equal(observed.targets.npm.bytes_verified,true);assert.equal(observed.targets.npm.status,'unknown');assert.equal(observed.recovery.available,false);assert.equal(observed.recovery.publication_state,'repairable');assert.equal(observed.recovery.channel_recovery,'observe-only');assert.doesNotMatch(readFileSync(join(cwd,'summary.md'),'utf8'),/gh workflow run/);
 }
});
