// Merge explicit immutable producer observations without discarding healthy evidence.
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,relative} from 'node:path';
import {writeResult,reportExitCode} from '../.github/release-train/release-result.mjs';
import {recoveryFromArtifact} from '../.github/release-train/observe-github.mjs';
import {observeRelease} from './release-observe.mjs';
import {inspectRecovery} from './release-recover.mjs';
import {receiptObservation} from './release-receipt.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const states=new Set(['completed','failed','in-progress','not-run','unknown']);
const observationErrors=[];
function observations(root){
 if(!existsSync(root))return [];
 return readdirSync(root).flatMap(name=>{
  const path=join(root,name);
  try{
   if(statSync(path).isDirectory())return observations(path);
   if(name!=='release-result.json')return [];
   const source=JSON.parse(readFileSync(path));
   if(!object(source)||!/^[a-f0-9]{40}$/.test(source.candidate_sha||'')||!['passed','failed','not-run'].includes(source.verification)||(source.observed_at!==undefined&&(typeof source.observed_at!=='string'||!Number.isFinite(Date.parse(source.observed_at))))||!object(source.targets)||Object.values(source.targets).some(target=>!object(target)||!states.has(target.status))||(source.artifacts!==undefined&&(!Array.isArray(source.artifacts)||source.artifacts.some(artifact=>!object(artifact))))||(source.errors!==undefined&&(!Array.isArray(source.errors)||source.errors.some(error=>typeof error!=='string'&&!object(error))))||(source.version!==undefined&&source.version!==null&&(typeof source.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source.version))))throw Error('Invalid producer observation');
   return [source];
  }catch{observationErrors.push(`producer observation could not be parsed or validated: ${relative('release-observations',path)}`);return [];}
 });
}
const sources=observations('release-observations').sort((a,b)=>Number(Boolean(a.artifacts?.length||a.recovery?.source_run_id))-Number(Boolean(b.artifacts?.length||b.recovery?.source_run_id)));
const config=existsSync('.github/release-train.json')?JSON.parse(readFileSync('.github/release-train.json')):{};
const intended=config.intended_targets||['npm','github-packages','github-release',...(process.env.RELEASE_HOMEBREW==='true'?['homebrew']:[])];
const targets=Object.fromEntries(intended.map(name=>[name,{status:'not-run'}]));
let result={candidate_sha:process.env.GITHUB_SHA,baseline_tag:null,version:null,verification:'not-run',recovery:null,artifacts:[]};
for(const source of sources){
 if(source.version||source.recovery||!result.baseline_tag)result={...result,...source};
 for(const [name,receipt]of Object.entries(source.targets)){
  const observation=source.schema_version===2||receipt.status!=='completed'?receipt:{...receipt,status:'unknown',reason:'Legacy schema1 receipt cannot establish channel completion'};
  if(observation.status!=='not-run'&&targets[name]?.status!=='completed')targets[name]=observation;
 }
}
const stages=[['verification',process.env.FINAL_VERIFY_RESULT],['audit',process.env.FINAL_AUDIT_RESULT],['publication',process.env.FINAL_RELEASE_RESULT],['recovery',process.env.FINAL_RECOVER_RESULT]];
const failure=stages.find(([,status])=>['failure','cancelled'].includes(status));
if(stages.slice(0,2).some(([,status])=>['failure','cancelled'].includes(status)))result.verification='failed';
if(process.env.FINAL_OPERATION==='recover'&&process.env.RELEASE_ENABLED!=='true')result.verification='not-run';
const infrastructure=[...observationErrors];
for(const producer of ['VERIFY','RELEASE','RECOVER','DISABLED_RECOVERY']){
 const id=process.env[`FINAL_${producer}_ARTIFACT_ID`],outcome=process.env[`FINAL_${producer}_DOWNLOAD_OUTCOME`],status=process.env[`FINAL_${producer}_RESULT`];
 if(outcome==='failure'||outcome==='cancelled')infrastructure.push(`${producer.toLowerCase()} producer artifact download ${outcome}`);
 else if(id!==undefined&&status&&status!=='skipped'&&!id)infrastructure.push(`${producer.toLowerCase()} producer did not retain a result artifact ID`);
}
let inspectedOriginal=null,inspectionFailed=false;
const dispatch=process.env.FINAL_OPERATION==='recover'&&(process.env.SOURCE_RUN_ID||process.env.ARTIFACT_ID)?{source_run_id:process.env.SOURCE_RUN_ID||null,artifact_id:process.env.ARTIFACT_ID||null}:null;
if(dispatch){
 // Dispatch values are diagnostics until the original run, payload and effects pass readback.
 result.recovery={...dispatch,available:false,identity_verified:false,blocked_reason:'Original dispatch identities have not been verified'};
 if(process.env.RELEASE_ENABLED==='true'){
  try{
   inspectedOriginal=inspectRecovery({repository:process.env.GITHUB_REPOSITORY,sourceRunId:dispatch.source_run_id,artifactId:dispatch.artifact_id});
   const {source,sourceAttempt,metadata,analysis,expectedAssets}=inspectedOriginal;
   result={...result,candidate_sha:metadata.candidate_sha,version:metadata.version,baseline_tag:analysis.baseline_tag??metadata.baseline_tag??null,artifacts:[{...source,source_attempt:sourceAttempt,tag:metadata.tag,tag_format:metadata.tag_format??analysis.tag_format,repository:metadata.repository,sha256:metadata.sha256,notes:analysis.notes,expected_assets:expectedAssets}]};
  }catch(error){inspectionFailed=true;result.recovery={...dispatch,available:false,identity_verified:false,blocked_reason:error.message};}
 }
}
const sealed=result.artifacts?.find(artifact=>artifact.artifact_id)||result.artifacts?.find(artifact=>/^[a-f0-9]{64}$/.test(artifact.sha256||''));
for(const [name,receipt]of Object.entries(targets)){
 targets[name]=receiptObservation(receipt,{candidate_sha:result.candidate_sha,version:result.version,sha256:sealed?.sha256},name);
}
const gh=endpoint=>JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',timeout:20000}));
if(process.env.RELEASE_ENABLED==='true'&&result.version&&!Object.values(targets).every(target=>target.status==='completed')&&!inspectionFailed){
 const original=dispatch||(result.recovery?.source_run_id?result.recovery:sealed);
 result.recovery={...original,available:false,blocked_reason:'Original sealed artifact and tag have not been confirmed.'};
 if(original?.artifact_id&&original?.source_run_id){
  try{
   const repository=process.env.GITHUB_REPOSITORY||sealed?.repository;
   const artifact=inspectedOriginal?.artifact||gh(`repos/${repository}/actions/artifacts/${original.artifact_id}`);
   const run=inspectedOriginal?.run||gh(`repos/${repository}/actions/runs/${original.source_run_id}`);
   const tag=original.tag||sealed?.tag||result.version;
   const metadata={candidate_sha:result.candidate_sha,version:result.version,tag,tag_format:sealed?.tag_format,repository,sha256:sealed?.sha256};
   const publicationObservation=inspectedOriginal?.publicationObservation||observeRelease({metadata,notes:sealed?.notes,expectedAssets:sealed?.expected_assets});
   result.recovery={...original,...recoveryFromArtifact({plan:{candidate_sha:result.candidate_sha,version:result.version,tag},repository,sourceRunId:original.source_run_id,artifactId:original.artifact_id,run,artifact,publicationObservation,workflow:config.workflow||'.github/workflows/release.yml',allowCurrentRunId:process.env.GITHUB_RUN_ID,recoveryArtifactPrefix:`release-receipts-${result.candidate_sha}`}),publication_state:publicationObservation.recovery.state};
  }catch(error){result.recovery={...original,available:false,blocked_reason:error.message};}
 }
}
const blockedChannels=Object.entries(targets).filter(([,receipt])=>receipt.channel_blocked===true).map(([name])=>name);
if(blockedChannels.length){
 result.recovery={...result.recovery,available:false,channel_recovery:'observe-only',blocked_reason:`${blockedChannels.join(', ')} latest channel is unconfirmed. Recovery never changes latest or removes temporary tags; retain the original payload until channel delivery is verified.`};
 result.errors=[...(result.errors||[]),...blockedChannels.map(name=>({message:`${name}: ${targets[name].reason||'Latest channel is unconfirmed'}`}))];
}
const final=writeResult('release-result.json',{...result,publication:undefined,schema_version:2,enabled:process.env.RELEASE_ENABLED==='true',concluded:true,intended_targets:intended,targets,failure_stage:infrastructure.length?'report-inputs':failure?.[0]||result.failure_stage||null,errors:[...infrastructure.map(message=>({message})),...(result.errors||[]),...(failure?[{message:`${failure[0]} job ${failure[1]}; inspect its Actions log`}]:[])]});
process.exitCode=reportExitCode(final);
