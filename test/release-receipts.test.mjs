import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const candidate = 'a'.repeat(40);
function observe(receipt) {
 const cwd=mkdtempSync(join(tmpdir(),'npm-receipt-'));
 mkdirSync(join(cwd,'release-input/receipts'),{recursive:true});
 writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify({candidate_sha:candidate,version:'2.0.0',sha256:'b'.repeat(64)}));
 if(receipt)writeFileSync(join(cwd,'release-input/receipts/npm.json'),JSON.stringify(receipt));
 const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'publish'],{cwd,env:{...process.env,GITHUB_SHA:candidate,RELEASE_ENABLED:'true',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',GITHUB_STEP_SUMMARY:''},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 return JSON.parse(readFileSync(join(cwd,'release-result.json')));
}
test('receipt existence and stale candidate never confirm publication',()=>{
 for(const receipt of [{},{status:'completed',candidate_sha:'c'.repeat(40),version:'2.0.0',observed_at:new Date().toISOString(),url:'https://www.npmjs.com/package/example/v/2.0.0',sha256:'b'.repeat(64)}])assert.notEqual(observe(receipt).targets.npm.status,'completed');
});
test('concluded synchronous publisher without readback cannot remain in progress',()=>{
 assert.notEqual(observe().publication,'in-progress');
});
test('reporting selects immutable producer IDs across failed-only retries',()=>{
 const workflow=readFileSync('.github/workflows/release.yml','utf8');
 assert.doesNotMatch(workflow,/pattern: ['"]?\*result\*/);
 assert.match(workflow,/needs\.release\.outputs\.result-artifact-id/);
 assert.match(workflow,/steps\.sealed\.outputs\.artifact-id/);
});

test('all-job retry cannot reinterpret a tag created by partial publication as no-release',()=>{
 const workflow=readFileSync('.github/workflows/release.yml','utf8');
 const guard=workflow.slice(workflow.indexOf('      - name: Stop ambiguous'),workflow.indexOf('      - name: Analyze exact'));
 assert.match(guard,/GITHUB_RUN_ATTEMPT/);assert.match(guard,/exit 1/);assert.match(guard,/attempts\/1/);
 const script=guard.slice(guard.indexOf('        run: |')+'        run: |'.length).split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n');
 for(const attempt of ['1','2']){
  const result=spawnSync('bash',['-eu','-c',script],{env:{...process.env,GITHUB_RUN_ATTEMPT:attempt,GITHUB_SERVER_URL:'https://github.com',GITHUB_REPOSITORY:'owner/repo',GITHUB_RUN_ID:'12'},encoding:'utf8'});
  assert.equal(result.status===0,attempt==='1');
 }
 const publisher=workflow.slice(workflow.indexOf('  release:'),workflow.indexOf('  recover:'));
 assert.doesNotMatch(publisher,/Analysis retry stopped/);
 assert.match(publisher,/needs\.verify\.outputs\.artifact-id/);
});

test('matching receipt confirms only its channel and a conflicting digest remains unconfirmed',()=>{
 const receipt={status:'completed',candidate_sha:candidate,version:'2.0.0',observed_at:'2026-11-08T00:00:00Z',remote_id:'example@2.0.0',sha256:'b'.repeat(64)};
 const matched=observe(receipt);assert.equal(matched.targets.npm.status,'completed');assert.equal(matched.publication,'partial');assert.equal(matched.targets['github-packages'].status,'not-run');
 assert.notEqual(observe({...receipt,sha256:'c'.repeat(64)}).targets.npm.status,'completed');
});
