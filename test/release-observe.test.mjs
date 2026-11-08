import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const candidate='a'.repeat(40),checksum=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function sealedFixture(tag='v2.0.0'){
 const cwd=mkdtempSync(join(tmpdir(),'npm-publication-observation-'));mkdirSync(join(cwd,'release-input'));mkdirSync(join(cwd,'bin'));
 const archive=Buffer.from('Synthetic original verified archive');
 const metadata={candidate_sha:candidate,version:'2.0.0',tag,repository:'owner/repo',source_run_id:'12',source_attempt:'1',sha256:checksum(archive).slice(7)};
 writeFileSync(join(cwd,'release-input/final.tgz'),archive);writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify(metadata));
 writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify({...metadata,notes:'Original notes'}));
 return {cwd,metadata,archive};
}
test('sealed producer result retains original notes and both exact asset digests for read-only recovery observation',()=>{
 const {cwd,metadata,archive}=sealedFixture();
 for(const recovery of [false,true]){
 if(recovery)writeFileSync(join(cwd,'release-input/recovery.json'),JSON.stringify({artifact_id:'34',source_run_id:'12'}));
 const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),recovery?'recover':'publish'],{cwd,env:{...process.env,GITHUB_SHA:candidate,RELEASE_ENABLED:'true',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'failure',GITHUB_STEP_SUMMARY:'',SEALED_ARTIFACT_ID:recovery?'':'34'},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const artifact=JSON.parse(readFileSync(join(cwd,'release-result.json'))).artifacts[0];
 assert.equal(artifact.artifact_id,'34');assert.equal(artifact.source_run_id,'12');assert.equal(artifact.notes,'Original notes');assert.equal(artifact.expected_assets['final.tgz'],checksum(archive));assert.equal(artifact.expected_assets['final.json'],checksum(readFileSync(join(cwd,'release-input/final.json'))));assert.equal(artifact.sha256,metadata.sha256);
 }
});
test('read-only preflight supports both plain and v-prefixed original npm tags with matching drafts',()=>{
 for(const tag of ['2.0.0','v2.0.0']){
 const {cwd,metadata}=sealedFixture(tag),expected=Object.fromEntries(['final.tgz','final.json'].map(name=>[name,checksum(readFileSync(join(cwd,'release-input',name)))]));
 writeFileSync(join(cwd,'bin/gh'),`#!/usr/bin/env node
const path=process.argv[3];if(path.includes('/git/ref/tags/'))console.log(JSON.stringify({ref:'refs/tags/${tag}',object:{type:'commit',sha:'${candidate}'}}));else if(path.includes('/releases/tags/'))console.log(JSON.stringify({id:77,tag_name:'${tag}',body:'Original notes',draft:true,prerelease:false,assets:${JSON.stringify(Object.entries(expected).map(([name,digest],index)=>({id:index+100,name,digest})))}}));else process.exit(99);
`,{mode:0o755});
 const script=`import {observeRelease} from ${JSON.stringify(resolve('scripts/release-observe.mjs'))};console.log(JSON.stringify(observeRelease({metadata:${JSON.stringify(metadata)},notes:'Original notes'})));`;
 const run=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH},encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);const observed=JSON.parse(run.stdout);assert.equal(observed.recovery.state,'repairable',JSON.stringify(observed));assert.equal(observed.targets.github.status,'unknown');assert.equal(observed.targets.stable_tag.candidate_sha,candidate);
 }
});
