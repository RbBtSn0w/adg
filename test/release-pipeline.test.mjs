import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare, publish } from '../scripts/release-payload.mjs';
import { validatePayload } from '../scripts/release-recover.mjs';
import { createPipelinePlan } from '../.github/release-train/pipeline-contract.mjs';
import { releaseEnv } from './helpers/release-env.mjs';
const candidate = 'a'.repeat(40), version = '2.0.0';
const notes = '## 2.0.0\n\n### BREAKING CHANGES\n\nKeep every original note.\n';
function composition(ids) {
  return {schema_version:2,protocol_version:1,profile:'npm',cadence:{},intended_targets:ids,pipeline:{stages:[{id:'original-observe',implementation:'public-fixture',operation:'observe',depends_on:[],inputs:[],outputs:[],effect:'read',execution:{provider:'fixture',job:'observe'}}],goals:ids.map(id=>({id,stages:['original-observe'],asynchronous:false,recovery:'supported'}))}};
}
function fixture() {
  const cwd=mkdtempSync(join(tmpdir(),'release-pipeline-')),root=join(cwd,'release-input/unpacked/package');
  mkdirSync(root,{recursive:true});mkdirSync(join(cwd,'.github'));
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'}));
  writeFileSync(join(root,'original.js'),'original payload');
  const pipeline=createPipelinePlan({config:composition(['npm','github-packages']),identity:{repository:'owner/fixture',candidate_sha:candidate,version,tag:'v2.0.0',notes}});
  const analysis={candidate_sha:candidate,version,tag:'v2.0.0',notes,baseline_tag:'v1.0.0',pipeline};
  writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify(analysis));
  writeFileSync(join(cwd,'.github/release-train.json'),JSON.stringify(composition(['new-current-goal'])));
  const context={cwd,env:{...releaseEnv(cwd),GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1'},nextRelease:{version,gitTag:'v2.0.0',notes}};
  return {cwd,root,analysis,pipeline,context};
}
test('prepare seals the complete original pipeline without changing notes or immutable envelope',async()=>{
  const f=fixture();try {
    await prepare({},f.context);
    const metadata=JSON.parse(readFileSync(join(f.cwd,'release-input/final.json')));
    assert.deepEqual(metadata.pipeline,f.pipeline);
    assert.equal(metadata.notes,notes);
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd,'release-input/analysis.json'))),f.analysis);
    assert.equal(readFileSync(join(f.root,'original.js'),'utf8'),'original payload');
  } finally {rmSync(f.cwd,{recursive:true,force:true});}
});
test('original pipeline candidate mismatch rejects prepare before payload mutation',async()=>{
  const f=fixture();try {
    const other=createPipelinePlan({config:composition(['npm','github-packages']),identity:{...f.pipeline.identity,candidate_sha:'b'.repeat(40)}});
    writeFileSync(join(f.cwd,'release-input/analysis.json'),JSON.stringify({...f.analysis,pipeline:other}));
    await assert.rejects(prepare({},f.context),/pipeline|identit/i);
    assert.equal(JSON.parse(readFileSync(join(f.root,'package.json'))).version,'1.0.0');
    assert.equal(existsSync(join(f.cwd,'release-input/final.json')),false);
  } finally {rmSync(f.cwd,{recursive:true,force:true});}
});
test('publish and direct recovery finalization reject inconsistent pipeline before any provider call',async()=>{
  const f=fixture();try {
    await prepare({},f.context);
    const path=join(f.cwd,'release-input/final.json'),metadata=JSON.parse(readFileSync(path));
    const other=createPipelinePlan({config:composition(['npm','github-packages']),identity:{...f.pipeline.identity,candidate_sha:'b'.repeat(40)}});
    const corrupt={...metadata,pipeline:other};writeFileSync(path,JSON.stringify(corrupt));
    const bin=join(f.cwd,'blocked-bin');mkdirSync(bin);
    for(const command of ['npm','gh'])writeFileSync(join(bin,command),'#!/bin/sh\ntouch "'+join(f.cwd,'provider-call')+'"\nexit 99\n',{mode:0o755});
    const context={...f.context,env:{...f.context.env,PATH:bin+':'+f.context.env.PATH}};
    for(const recovery of [false,true])await assert.rejects(publish({recovery},context),/pipeline|identit/i);
    assert.throws(()=>validatePayload(corrupt,f.analysis,join(f.cwd,'release-input/final.tgz')),/pipeline|identit/i);
    assert.equal(existsSync(join(f.cwd,'provider-call')),false);
  } finally {rmSync(f.cwd,{recursive:true,force:true});}
});
test('status and finalizer preserve original goal set through sealed artifact evidence after configuration changes',async()=>{
  const f=fixture();try {
    await prepare({},f.context);
    const env={...f.context.env,GITHUB_SHA:candidate,RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',SEALED_ARTIFACT_ID:'34',GITHUB_STEP_SUMMARY:''};
    const status=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'publish'],{cwd:f.cwd,env,encoding:'utf8'});
    assert.equal(status.status,0,status.stderr);
    const producer=JSON.parse(readFileSync(join(f.cwd,'release-result.json')));
    assert.deepEqual(producer.intended_targets,['npm','github-packages']);
    assert.equal(producer.pipeline.source,'original-plan');
    assert.deepEqual(producer.artifacts[0].pipeline,f.pipeline);
    assert.equal(producer.artifacts[0].notes,notes);
    mkdirSync(join(f.cwd,'release-observations'));
    writeFileSync(join(f.cwd,'release-observations/release-result.json'),JSON.stringify(producer));
    const bin=join(f.cwd,'observer-bin');mkdirSync(bin);writeFileSync(join(bin,'gh'),'#!/bin/sh\nexit 23\n',{mode:0o755});
    const final=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd:f.cwd,env:{...env,PATH:bin+':'+env.PATH,FINAL_OPERATION:'release'},encoding:'utf8'});
    assert.equal(final.status,1,final.stderr);
    const result=JSON.parse(readFileSync(join(f.cwd,'release-result.json')));
    assert.deepEqual(result.intended_targets,['npm','github-packages']);
    assert.equal(result.targets['new-current-goal'],undefined);
    assert.equal(result.pipeline.source,'original-plan');assert.equal(result.pipeline.plan_digest,f.pipeline.digest);
    assert.deepEqual(result.artifacts[0].pipeline,f.pipeline);
  } finally {rmSync(f.cwd,{recursive:true,force:true});}
});
test('legacy recovery does not acquire the current configuration pipeline',async()=>{
  const f=fixture();try {
    const legacy={...f.analysis};delete legacy.pipeline;
    writeFileSync(join(f.cwd,'release-input/analysis.json'),JSON.stringify(legacy));
    await prepare({},f.context);
    const run=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'recover'],{cwd:f.cwd,env:{...f.context.env,GITHUB_SHA:candidate,GITHUB_STEP_SUMMARY:''},encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(readFileSync(join(f.cwd,'release-result.json')));
    assert.equal(result.pipeline,undefined);
  } finally {rmSync(f.cwd,{recursive:true,force:true});}
});

test('legacy finalizer retains explicit producer goals instead of current recovery configuration',()=>{
 const f=fixture();try {
  mkdirSync(join(f.cwd,'release-observations'));
  writeFileSync(join(f.cwd,'release-observations/release-result.json'),JSON.stringify({schema_version:2,candidate_sha:candidate,version,verification:'passed',intended_targets:['npm','github-packages'],targets:{npm:{status:'unknown'},'github-packages':{status:'unknown'}},artifacts:[]}));
  const run=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd:f.cwd,env:{...f.context.env,GITHUB_SHA:candidate,FINAL_OPERATION:'recover',GITHUB_STEP_SUMMARY:''},encoding:'utf8'});
  assert.equal(run.status,1,run.stderr);
  const result=JSON.parse(readFileSync(join(f.cwd,'release-result.json')));
  assert.deepEqual(result.intended_targets,['npm','github-packages']);assert.equal(result.pipeline,undefined);
 } finally {rmSync(f.cwd,{recursive:true,force:true});}
});
