import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const candidate='a'.repeat(40),names=['npm','github-packages','github-release'];
const receipt={status:'completed',candidate_sha:candidate,version:'2.0.0',observed_at:'2026-11-08T00:00:00Z',remote_id:'example@2.0.0',sha256:'b'.repeat(64),notes:'Original release notes',expected_assets:{'final.tgz':'sha256:'+'b'.repeat(64),'final.json':'sha256:'+'d'.repeat(64)}};
function report(source,extra={}){
 const cwd=mkdtempSync(join(tmpdir(),'npm-report-guard-'));mkdirSync(join(cwd,'release-observations'));mkdirSync(join(cwd,'bin'));
 writeFileSync(join(cwd,'release-observations/release-result.json'),JSON.stringify(source));
 const originalRun={id:12,repository:{full_name:'owner/repo'},path:extra.WRONG_WORKFLOW?'.github/workflows/ci.yml':'.github/workflows/release.yml',head_branch:'main',head_sha:candidate,event:'schedule',status:'completed',run_attempt:2};
 const artifact={id:34,expired:false,name:extra.WRONG_ROLE?'npm-package-'+candidate+'-1':'release-receipts-'+candidate+'-1',digest:'sha256:'+'c'.repeat(64),expires_at:'2099-01-01T00:00:00Z',workflow_run:{id:12,head_sha:candidate}};
 writeFileSync(join(cwd,'bin/gh'),`#!/usr/bin/env node
const endpoint=process.argv[3];if(endpoint.endsWith('/artifacts/34'))console.log(${JSON.stringify(JSON.stringify(artifact))});else if(endpoint.endsWith('/runs/12'))console.log(${JSON.stringify(JSON.stringify(originalRun))});else if(endpoint.includes('/git/ref/tags/'))console.log(JSON.stringify({ref:'refs/tags/v2.0.0',object:{type:'commit',sha:'${candidate}'}}));else if(endpoint.endsWith('/releases')||endpoint.includes('/releases/tags/')){const mode=${JSON.stringify(extra.REMOTE_MODE || 'missing-release')};if(mode==='read-error')process.exit(22);const release={id:77,tag_name:'v2.0.0',body:mode==='notes-conflict'?'Conflict':'Original release notes',draft:false,prerelease:false,assets:mode==='asset-conflict'?[{id:101,name:'final.tgz',digest:'sha256:'+'f'.repeat(64)}]:[]};console.log(JSON.stringify(endpoint.endsWith('/releases')?(mode==='missing-release'?[[]]:[[release]]):release));}else process.exit(99);
`,{mode:0o755});
 const run=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,GITHUB_SHA:candidate,GITHUB_RUN_ID:'99',GITHUB_REPOSITORY:'owner/repo',RELEASE_ENABLED:'true',GITHUB_STEP_SUMMARY:join(cwd,'summary.md'),...extra},encoding:'utf8'});
 return {run,result:JSON.parse(readFileSync(join(cwd,'release-result.json'))),summary:readFileSync(join(cwd,'summary.md'),'utf8')};
}
const base={schema_version:2,candidate_sha:candidate,version:'2.0.0',analysis:'success',verification:'passed',targets:{},artifacts:[]};
test('final native job fails after durable JSON and Summary for synchronous incomplete publication',()=>{
 const value=report(base);assert.equal(value.run.status,1,value.run.stderr);assert.equal(value.result.publication,'failed');assert.match(value.summary,/Publication/);
});
test('legacy schema1 channel claims cannot be promoted by aggregate schema2',()=>{
 const value=report({...base,schema_version:1,targets:Object.fromEntries(names.map(name=>[name,receipt]))});assert.notEqual(value.result.publication,'completed');assert.notEqual(value.result.targets.npm.status,'completed');assert.equal(value.run.status,1);
});
test('report infrastructure failure is durable and fails native job even with complete remote receipts',()=>{
 const value=report({...base,targets:Object.fromEntries(names.map(name=>[name,receipt]))},{FINAL_RELEASE_RESULT:'success',FINAL_RELEASE_ARTIFACT_ID:'34',FINAL_RELEASE_DOWNLOAD_OUTCOME:'failure'});assert.equal(value.run.status,1);assert.equal(value.result.failure_stage,'report-inputs');
});
test('explicit asynchronous pending snapshot retains a successful reporter exit',()=>{
 const value=report({...base,asynchronous:true,targets:{npm:{status:'in-progress'}}});assert.equal(value.run.status,0,value.run.stderr);assert.equal(value.result.publication,'in-progress');
});
test('recovery instructions reject original runs from another workflow and unrelated artifact roles',()=>{
 const original={artifact_id:'34',source_run_id:'12',source_attempt:'1',tag:'v2.0.0',repository:'owner/repo',sha256:'b'.repeat(64),notes:'Original release notes',expected_assets:{'final.tgz':'sha256:'+'b'.repeat(64),'final.json':'sha256:'+'d'.repeat(64)}};
 for(const extra of [{WRONG_WORKFLOW:'true'},{WRONG_ROLE:'true'}]){const value=report({...base,targets:{npm:receipt},artifacts:[original]},extra);assert.equal(value.result.recovery.available,false);assert.doesNotMatch(value.summary,/gh workflow run/);}
});
test('outcome observes failed downloads and always preserves its durable artifact',()=>{
 const workflow=readFileSync('.github/workflows/release.yml','utf8');
 const result=workflow.slice(workflow.indexOf('  result:'));
 assert.match(result,/name: Record final verification and publication result\n\s+if: always\(\)/);
 assert.match(result,/name: Preserve aggregate result\n\s+if: always\(\)/);
 assert.match(result,/FINAL_RELEASE_DOWNLOAD_OUTCOME:/);
 assert.match(result,/FINAL_RELEASE_ARTIFACT_ID:/);
});

test('failure Summary never offers recovery for conflicting remote notes/assets or unknown readback',()=>{
 const original={artifact_id:'34',source_run_id:'12',source_attempt:'1',tag:'v2.0.0',repository:'owner/repo',sha256:'b'.repeat(64),notes:'Original release notes',expected_assets:{'final.tgz':'sha256:'+'b'.repeat(64),'final.json':'sha256:'+'d'.repeat(64)}};
 for(const mode of ['notes-conflict','asset-conflict','read-error']){
  const value=report({...base,targets:{npm:receipt},artifacts:[original]},{REMOTE_MODE:mode});
  assert.equal(value.result.recovery.available,false,mode);assert.equal(value.result.recovery.publication_state,mode==='read-error'?'unknown':'conflict',mode);assert.doesNotMatch(value.summary,/gh workflow run/,mode);
 }
});
