import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
function outcome(cwd,artifactId='34'){
 const run=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,STATE:cwd,REMOTE_MODE:'early-tag-read-error',GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'99',GITHUB_REPOSITORY:'owner/repo',RELEASE_ENABLED:'true',FINAL_OPERATION:'recover',FINAL_VERIFY_RESULT:'skipped',FINAL_RELEASE_RESULT:'skipped',FINAL_RECOVER_RESULT:'failure',SOURCE_RUN_ID:'12',ARTIFACT_ID:artifactId,GITHUB_STEP_SUMMARY:join(cwd,'summary.md')},encoding:'utf8'});
 assert.equal(run.status,1,run.stderr);return {result:JSON.parse(readFileSync(join(cwd,'release-result.json'))),summary:readFileSync(join(cwd,'summary.md'),'utf8')};
}
test('early recovery failure retains dispatch identities and can offer retry only after original read-only revalidation',()=>{
 const {cwd,result:failed}=runRecovery('early-tag-read-error');assert.notEqual(failed.status,0);assert.equal(existsSync(join(cwd,'release-input/recovery.json')),false);
 const {result,summary}=outcome(cwd);assert.equal(result.recovery.source_run_id,'12');assert.equal(result.recovery.artifact_id,'34');assert.equal(result.recovery.available,true);assert.equal(result.candidate_sha,'a'.repeat(40));assert.equal(result.version,'2.0.0');assert.match(summary,/source_run_id=12/);assert.match(summary,/artifact_id=34/);
});
test('unverified dispatch identities survive diagnostics without producing a recovery command',()=>{
 const {cwd}=runRecovery('early-tag-read-error');const {result,summary}=outcome(cwd,'999');assert.equal(result.recovery.source_run_id,'12');assert.equal(result.recovery.artifact_id,'999');assert.equal(result.recovery.available,false);assert.doesNotMatch(summary,/gh workflow run/);
});
test('workflow passes original dispatch IDs into the final read-only recovery observer',()=>{
 const workflow=readFileSync('.github/workflows/release.yml','utf8'),final=workflow.slice(workflow.indexOf('  result:'));
 assert.match(final,/SOURCE_RUN_ID: \$\{\{ inputs.source_run_id \}\}/);assert.match(final,/ARTIFACT_ID: \$\{\{ inputs.artifact_id \}\}/);
});

test('early stage snapshot preserves original dispatch IDs as unverified diagnostics',()=>{
 const {cwd}=runRecovery('early-tag-read-error');
 const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'recover'],{cwd,env:{...process.env,GITHUB_SHA:'b'.repeat(40),RELEASE_ENABLED:'true',SOURCE_RUN_ID:'12',ARTIFACT_ID:'34',GITHUB_STEP_SUMMARY:''},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const value=JSON.parse(readFileSync(join(cwd,'release-result.json')));assert.equal(value.recovery.source_run_id,'12');assert.equal(value.recovery.artifact_id,'34');assert.equal(value.recovery.available,false);assert.equal(value.recovery.identity_verified,false);
});
