import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createPipelinePlan} from '../.github/release-train/pipeline-contract.mjs';
const candidate='a'.repeat(40),version='2.0.0';
const config=JSON.parse(readFileSync(new URL('../.github/release-train.json',import.meta.url)));
for(const entry of ['status','finalizer','recovery-finalizer'])for(const corruption of ['digest','identity'])test(`${entry} retains a failed report for invalid original ${corruption}`,()=>{
  const cwd=mkdtempSync(join(tmpdir(),'release-plan-diagnostics-'));
  try {
    mkdirSync(join(cwd,'release-input'),{recursive:true});mkdirSync(join(cwd,'release-observations'));mkdirSync(join(cwd,'bin'));
    const identity={repository:'example/fixture',candidate_sha:candidate,version,tag:'v2.0.0',notes:'Original notes'};
    const metadata={...identity,sha256:'f'.repeat(64),source_run_id:'12',artifact_id:'34',pipeline:createPipelinePlan({config,identity})};
    if(corruption==='digest')metadata.pipeline={...metadata.pipeline,digest:'sha256:'+'0'.repeat(64)};
    else metadata.notes='Changed notes';
    writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify(metadata));
    writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify(metadata));
    writeFileSync(join(cwd,'release-input/final.tgz'),'retained payload');
    writeFileSync(join(cwd,'release-observations/release-result.json'),JSON.stringify({schema_version:2,candidate_sha:candidate,version,verification:'passed',intended_targets:config.intended_targets,targets:{npm:{status:'unknown'}},artifacts:[metadata]}));
    for(const command of ['gh','npm'])writeFileSync(join(cwd,'bin',command),'#!/bin/sh\ntouch "'+join(cwd,'external-call')+'"\nexit 99\n',{mode:0o755});
    const summary=join(cwd,'summary.md');
    const env={...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,GITHUB_SHA:candidate,GITHUB_REPOSITORY:identity.repository,RELEASE_ENABLED:'true',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',FINAL_OPERATION:entry==='recovery-finalizer'?'recover':'release',...(entry==='recovery-finalizer'?{SOURCE_RUN_ID:'12',ARTIFACT_ID:'34'}:{}),SEALED_ARTIFACT_ID:'34',GITHUB_STEP_SUMMARY:summary};
    const run=spawnSync(process.execPath,[resolve(`scripts/release-${entry==='status'?'status':'finalize'}.mjs`),...(entry==='status'?['publish']:[])],{cwd,env,encoding:'utf8'});
    assert.equal(existsSync(join(cwd,'release-result.json')),true,run.stderr);
    const result=JSON.parse(readFileSync(join(cwd,'release-result.json')));
    assert.equal(result.failure_stage,'report-inputs');assert.equal(result.verification,'failed');
    assert.equal(result.recovery.available,false);assert.equal(result.recovery.command,undefined);
    assert.equal(result.pipeline,undefined);assert.ok(result.errors.some(error=>/original.*pipeline/i.test(error.message)));
    if(entry!=='status')assert.match(readFileSync(summary,'utf8'),/Original.*pipeline|report-inputs/i);
    assert.equal(existsSync(join(cwd,'external-call')),false);
  } finally {rmSync(cwd,{recursive:true,force:true});}
});

test('a failed producer handoff cannot be cleared by a healthy sibling or trigger recovery inspection',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'release-plan-handoff-'));
  try {
    mkdirSync(join(cwd,'release-input/receipts'),{recursive:true});mkdirSync(join(cwd,'release-observations'));mkdirSync(join(cwd,'bin'));
    const identity={repository:'example/fixture',candidate_sha:candidate,version,tag:'v2.0.0',notes:'Original notes'};
    const pipeline=createPipelinePlan({config,identity});
    const metadata={...identity,sha256:'f'.repeat(64),source_run_id:'12',source_attempt:1,pipeline:{...pipeline,digest:'sha256:'+'0'.repeat(64)}};
    writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify(metadata));
    writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify(metadata));writeFileSync(join(cwd,'release-input/final.tgz'),'retained payload');
    for(const target of config.intended_targets)writeFileSync(join(cwd,`release-input/receipts/${target}.json`),JSON.stringify({status:'completed',candidate_sha:candidate,version,sha256:metadata.sha256,observed_at:'2026-11-10T00:00:00Z',channel_observed_at:'2026-11-10T00:00:00Z',latest_version:version,remote_id:'fixture/'+target}));
    for(const command of ['gh','npm'])writeFileSync(join(cwd,'bin',command),'#!/bin/sh\ntouch "'+join(cwd,'external-call')+'"\nexit 99\n',{mode:0o755});
    const env={...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,GITHUB_SHA:candidate,GITHUB_REPOSITORY:identity.repository,RELEASE_ENABLED:'true',RESTORE_OUTCOME:'success',PUBLISH_OUTCOME:'success',FINAL_RELEASE_RESULT:'success',FINAL_VERIFY_RESULT:'success',SEALED_ARTIFACT_ID:'34',GITHUB_STEP_SUMMARY:''};
    const producer=spawnSync(process.execPath,[resolve('scripts/release-status.mjs'),'publish'],{cwd,env,encoding:'utf8'});
    assert.equal(producer.status,0,producer.stderr);
    const rejected=JSON.parse(readFileSync(join(cwd,'release-result.json')));
    assert.equal(rejected.failure_stage,'report-inputs');
    mkdirSync(join(cwd,'release-observations/release'));mkdirSync(join(cwd,'release-observations/verify'));
    writeFileSync(join(cwd,'release-observations/release/release-result.json'),JSON.stringify(rejected));
    writeFileSync(join(cwd,'release-observations/verify/release-result.json'),JSON.stringify({...rejected,verification:'passed',failure_stage:null,errors:[],artifacts:[{sha256:metadata.sha256}]}));
    for(const operation of ['release','recover','disabled-recover']) {
      const summary=join(cwd,'summary.md');
      const final=spawnSync(process.execPath,[resolve('scripts/release-finalize.mjs')],{cwd,env:{...env,FINAL_OPERATION:operation==='release'?'release':'recover',RELEASE_ENABLED:operation==='disabled-recover'?'false':'true',GITHUB_STEP_SUMMARY:summary,...(operation!=='release'?{SOURCE_RUN_ID:'12',ARTIFACT_ID:'34'}:{})},encoding:'utf8'});
      assert.equal(final.status,1,final.stderr);
      const result=JSON.parse(readFileSync(join(cwd,'release-result.json')));
      assert.equal(result.failure_stage,'report-inputs');assert.equal(result.verification,'failed');
      assert.notEqual(result.publication,'completed');assert.equal(result.pipeline,undefined);
      assert.equal(result.recovery.available,false);assert.equal(result.recovery.command,undefined);
      assert.ok(result.errors.some(error=>/original.*pipeline/i.test(error.message)));
      assert.equal(existsSync(join(cwd,'external-call')),false);
    }
  } finally {rmSync(cwd,{recursive:true,force:true});}
});
