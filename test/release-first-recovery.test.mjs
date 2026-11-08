import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const candidate='a'.repeat(40);
test('first failed publication surfaces original immutable recovery identity; later recovery keeps original lineage',()=>{
 for(const recovery of [false,true]){
 const cwd=mkdtempSync(join(tmpdir(),'npm-first-recovery-'));mkdirSync(join(cwd,'release-observations'));mkdirSync(join(cwd,'bin'));
 const original={artifact_id:'34',source_run_id:'12',source_attempt:'1',tag:'v2.0.0',repository:'owner/repo',sha256:'b'.repeat(64),notes:'Original release notes',expected_assets:{'final.tgz':'sha256:'+'b'.repeat(64),'final.json':'sha256:'+'d'.repeat(64)}};
 writeFileSync(join(cwd,'release-observations/release-result.json'),JSON.stringify({schema_version:2,candidate_sha:candidate,version:'2.0.0',baseline_tag:'v1.0.0',analysis:'success',verification:'passed',targets:{npm:{status:'completed',candidate_sha:candidate,version:'2.0.0',observed_at:'2026-11-08T00:00:00Z',remote_id:'example@2.0.0',sha256:'b'.repeat(64),notes:'Original release notes',expected_assets:{'final.tgz':'sha256:'+'b'.repeat(64),'final.json':'sha256:'+'d'.repeat(64)}}},artifacts:[original],...(recovery?{recovery:original}:{})}));
 writeFileSync(join(cwd,'bin/gh'),`#!/usr/bin/env node
const path=process.argv[3];
if(path==='repos/owner/repo/actions/artifacts/34')console.log(JSON.stringify({id:34,name:'release-receipts-${candidate}-1',expired:false,digest:'sha256:'+'c'.repeat(64),expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:12,head_sha:'${candidate}'}}));
else if(path==='repos/owner/repo/actions/runs/12')console.log(JSON.stringify({id:12,repository:{full_name:'owner/repo'},path:'.github/workflows/release.yml',head_branch:'main',head_sha:'${candidate}',event:'schedule',status:'${recovery ? 'completed' : 'in_progress'}',run_attempt:2}));
else if(path.startsWith('repos/owner/repo/releases?'))console.log('[]');
else if(path==='repos/owner/repo/releases')console.log('[[]]');
else if(path==='repos/owner/repo/git/ref/tags/v2.0.0')console.log(JSON.stringify({ref:'refs/tags/v2.0.0',object:{type:'commit',sha:'${candidate}'}}));
else process.exit(99);
`,{mode:0o755});
 const run=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,GITHUB_SHA:recovery?'d'.repeat(40):candidate,GITHUB_RUN_ID:recovery?'99':'12',GITHUB_RUN_ATTEMPT:'2',GITHUB_REPOSITORY:'owner/repo',RELEASE_ENABLED:'true',FINAL_VERIFY_RESULT:'success',FINAL_RELEASE_RESULT:'failure',GITHUB_STEP_SUMMARY:join(cwd,'summary.md')},encoding:'utf8'});
 assert.equal(run.status,1,run.stderr);const result=JSON.parse(readFileSync(join(cwd,'release-result.json')));
 assert.equal(result.publication,'partial');assert.equal(result.recovery.available,true);assert.equal(result.recovery.source_run_id,'12');assert.equal(result.recovery.artifact_id,'34');assert.equal(String(result.recovery.source_attempt),'1');assert.equal(result.recovery.digest,'sha256:'+'c'.repeat(64));
 const summary=readFileSync(join(cwd,'summary.md'),'utf8');assert.match(summary,/source_run_id=12/);assert.match(summary,/artifact_id=34/);assert.match(summary,/2099-01-01/);
 }
});
