import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('final observer reports failed audit after successful verification and skipped publication, including disabled mode',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'release-final-result-'));mkdirSync(join(cwd,'release-observations'));
 writeFileSync(join(cwd,'release-observations/release-result.json'),JSON.stringify({candidate_sha:'a'.repeat(40),version:'2.0.0',baseline_tag:'v1.0.0',verification:'passed',targets:{npm:{status:'not-run'},'github-packages':{status:'not-run'},'github-release':{status:'not-run'}},artifacts:[]}));
 for(const enabled of ['true','false']){
  const result=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env:{...process.env,GITHUB_SHA:'a'.repeat(40),RELEASE_ENABLED:enabled,FINAL_VERIFY_RESULT:'success',FINAL_AUDIT_RESULT:'failure',FINAL_RELEASE_RESULT:'skipped',GITHUB_STEP_SUMMARY:join(cwd,'summary.md')},encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);const observed=JSON.parse(readFileSync(join(cwd,'release-result.json')));
  assert.equal(observed.verification,'failed');assert.equal(observed.publication,enabled==='true'?'failed':'disabled');assert.equal(observed.failure_stage,'audit');
  assert.equal(observed.targets.npm.status,'not-run');
 }
});
