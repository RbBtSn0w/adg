import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('invalid sealed tag evidence persists report-inputs and independently valid sibling observations',()=>{
 for(const patch of [{tag_format:'other-${version}'},{tag:undefined},{tag_format:'v${version}-${channel}'}]){
  const cwd=mkdtempSync(join(tmpdir(),'release-status-inputs-'));mkdirSync(join(cwd,'release-input/receipts'),{recursive:true});mkdirSync(join(cwd,'bin'));
  const metadata={candidate_sha:'a'.repeat(40),version:'2.0.0',tag:'v2.0.0',sha256:'f'.repeat(64),source_run_id:'12',repository:'owner/repo',...patch};
  writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify(metadata));writeFileSync(join(cwd,'release-input/final.tgz'),'original bytes');writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify({candidate_sha:metadata.candidate_sha,version:metadata.version,tag:'v2.0.0',notes:'Original notes'}));
  writeFileSync(join(cwd,'release-input/receipts/npm.json'),JSON.stringify({status:'completed',candidate_sha:metadata.candidate_sha,version:metadata.version,sha256:metadata.sha256,observed_at:'2026-11-08T00:00:00Z',remote_id:'@scope/pkg@2.0.0',latest_version:'2.0.0',channel_observed_at:'2026-11-08T00:00:00Z'}));
  for(const name of ['gh','npm'])writeFileSync(join(cwd,'bin',name),'#!/bin/sh\ntouch "'+join(cwd,'external-call')+'"\nexit 99\n',{mode:0o755});
  const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'publish'],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,SEALED_ARTIFACT_ID:'34',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',RELEASE_ENABLED:'true',GITHUB_STEP_SUMMARY:''},encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const result=JSON.parse(readFileSync(join(cwd,'release-result.json')));
  assert.equal(result.failure_stage,'report-inputs');assert.equal(result.verification,'failed');assert.equal(result.targets.npm.status,'completed');assert.notEqual(result.targets['github-release'].status,'completed');assert.deepEqual(result.artifacts,[]);assert.ok(result.errors.some(error=>/sealed.*tag|tag.*format/i.test(error.message)));assert.equal(existsSync(join(cwd,'external-call')),false);
 }
});
