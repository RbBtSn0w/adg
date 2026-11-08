// Merge only explicit immutable producer observations, including successful prior attempts.
import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {writeResult,reportExitCode} from '../.github/release-train/release-result.mjs';
import {recoveryFromArtifact} from '../.github/release-train/observe-github.mjs';
function observations(root){
 if(!existsSync(root))return [];
 return readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?observations(path):name==='release-result.json'?[JSON.parse(readFileSync(path))]:[];});
}
const sources=observations('release-observations').sort((a,b)=>Number(Boolean(a.artifacts?.length||a.recovery?.source_run_id))-Number(Boolean(b.artifacts?.length||b.recovery?.source_run_id)));
const config=existsSync('.github/release-train.json')?JSON.parse(readFileSync('.github/release-train.json')):{};
const intended=config.intended_targets||['npm','github-packages','github-release',...(process.env.RELEASE_HOMEBREW==='true'?['homebrew']:[])];
const targets=Object.fromEntries(intended.map(name=>[name,{status:'not-run'}]));
let result={candidate_sha:process.env.GITHUB_SHA,baseline_tag:null,version:null,verification:'not-run',recovery:null,artifacts:[]};
for(const source of sources){
 if(source.version||source.recovery||!result.baseline_tag)result={...result,...source};
 for(const [name,receipt]of Object.entries(source.targets||{})){
  const observation=source.schema_version===2||receipt.status!=='completed'?receipt:{...receipt,status:'unknown',reason:'Legacy schema1 receipt cannot establish channel completion'};
  if(observation.status!=='not-run'&&targets[name]?.status!=='completed')targets[name]=observation;
 }
}
const stages=[['verification',process.env.FINAL_VERIFY_RESULT],['audit',process.env.FINAL_AUDIT_RESULT],['publication',process.env.FINAL_RELEASE_RESULT],['recovery',process.env.FINAL_RECOVER_RESULT]];
const failure=stages.find(([,status])=>['failure','cancelled'].includes(status));
if(stages.slice(0,2).some(([,status])=>['failure','cancelled'].includes(status)))result.verification='failed';
if(process.env.FINAL_OPERATION==='recover'&&process.env.RELEASE_ENABLED!=='true')result.verification='not-run';
const infrastructure=[];
for(const producer of ['VERIFY','RELEASE','RECOVER','DISABLED_RECOVERY']){
 const id=process.env[`FINAL_${producer}_ARTIFACT_ID`],outcome=process.env[`FINAL_${producer}_DOWNLOAD_OUTCOME`],status=process.env[`FINAL_${producer}_RESULT`];
 if(outcome==='failure'||outcome==='cancelled')infrastructure.push(`${producer.toLowerCase()} producer artifact download ${outcome}`);
 else if(id!==undefined&&status&&status!=='skipped'&&!id)infrastructure.push(`${producer.toLowerCase()} producer did not retain a result artifact ID`);
}
const gh=endpoint=>JSON.parse(execFileSync('gh',['api',endpoint],{encoding:'utf8',timeout:20000}));
const sealed=result.artifacts?.find(artifact=>artifact.artifact_id);
if(process.env.RELEASE_ENABLED==='true'&&result.version&&!Object.values(targets).every(target=>target.status==='completed')){
 const original=result.recovery?.source_run_id?result.recovery:sealed;
 result.recovery={available:false,blocked_reason:'Original sealed artifact and tag have not been confirmed.'};
 if(original?.artifact_id&&original?.source_run_id){
  try{
   const repository=process.env.GITHUB_REPOSITORY||sealed?.repository;
   const artifact=gh(`repos/${repository}/actions/artifacts/${original.artifact_id}`);
   const run=gh(`repos/${repository}/actions/runs/${original.source_run_id}`);
   const tag=original.tag||sealed?.tag||result.version;
   let object=gh(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`).object;
   for(let depth=0;object?.type==='tag'&&depth<8;depth++)object=gh(`repos/${repository}/git/tags/${object.sha}`).object;
   result.recovery=recoveryFromArtifact({plan:{candidate_sha:result.candidate_sha},repository,sourceRunId:original.source_run_id,artifactId:original.artifact_id,run,artifact,tagVerified:object?.type==='commit'&&object.sha===result.candidate_sha,workflow:config.workflow||'.github/workflows/release.yml',allowCurrentRunId:process.env.GITHUB_RUN_ID,recoveryArtifactPrefix:`release-receipts-${result.candidate_sha}`});
  }catch(error){result.recovery={available:false,blocked_reason:error.message};}
 }
}
const final=writeResult('release-result.json',{...result,publication:undefined,schema_version:2,enabled:process.env.RELEASE_ENABLED==='true',concluded:true,intended_targets:intended,targets,failure_stage:infrastructure.length?'report-inputs':failure?.[0]||result.failure_stage||null,errors:[...(infrastructure.map(message=>({message}))),...(failure?[{message:`${failure[0]} job ${failure[1]}; inspect its Actions log`}]:result.errors||[])]});
// Preserve JSON and Summary even when the native outcome job must remain failed.
process.exitCode=reportExitCode(final);
