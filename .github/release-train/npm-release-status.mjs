import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeResult} from './release-result.mjs';
import {recoveryFromArtifact} from './observe-github.mjs';
import {observeNpmGitHub,inspectRecovery} from './npm-recovery-source.mjs';
export {observeNpmGitHub} from './npm-recovery-source.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateLatestVersion,sealedTagFormat} from './npm-channel.mjs';
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function bindNpmReceipt(receipt,plan,cwd,sealedDirectory='release-sealed',sealedFiles){
 if(!receipt||(receipt.status!=='completed'&&receipt.bytes_verified!==true&&receipt.channel_blocked!==true))return receipt;
 let bytesVerified=false;
 try{
  if(!/^[a-f0-9]{64}$/.test(plan?.sha256||'')||receipt.candidate_sha!==plan.candidate_sha||receipt.version!==plan.version||receipt.sha256!==plan.sha256||createHash('sha256').update(sealedFiles?.['final.tgz']??readFileSync(join(cwd,sealedDirectory,'final.tgz'))).digest('hex')!==plan.sha256)throw Error('Npm receipt does not match the original sealed payload');
  bytesVerified=true;
  if(receipt.status!=='completed')return {...receipt,bytes_verified:true,channel_blocked:receipt.channel_blocked===true};
  validateLatestVersion(plan,receipt.latest_version);
  if(!Number.isFinite(Date.parse(receipt.channel_observed_at)))throw Error('Npm channel observation time is unavailable');
  return receipt;
 }catch(error){return {...receipt,status:'unknown',bytes_verified:bytesVerified,channel_blocked:bytesVerified,reason:error.message};}
}
export function reportStatus({cwd=process.cwd(),env=process.env,mode='verify'}={}){
 const plan=read(join(cwd,'release-sealed/final.json'))||read(join(cwd,'release-input/release-plan.json'))||read(join(cwd,'release-plan.json'))||{};
 let verification='not-run';
 if(mode==='verify')verification=env.ANALYSIS_STATUS==='success'&&plan.schema_version===1&&plan.candidate_sha===env.CANDIDATE_SHA&&typeof plan.release_needed==='boolean'&&(!plan.release_needed||(env.PRODUCT_CHECK_STATUS==='success'&&env.PACKAGE_STATUS==='success'))?'passed':'failed';
 else if(mode==='release')verification=env.RESTORE_STATUS==='success'?'passed':'failed';
 else if(mode==='recover')verification=existsSync(join(cwd,'release-sealed/recovery.json'))?'passed':'failed';
 let failure=verification==='failed'?'verification':env.RELEASE_STATUS==='failure'?mode:null;
 const targets={};let unknown=false;
 for(const name of ['npm','github']){
  const receipt=read(join(cwd,`release-sealed/receipts/${name==='github'?'github-release':name}.json`));
  targets[name]=(name==='npm'?bindNpmReceipt(receipt,plan,cwd):receipt)||{status:failure&&verification==='passed'&&!unknown?'unknown':'not-run'};
  if(targets[name].status==='unknown')unknown=true;
 }
 return writeResult(join(cwd,'release-result.json'),{schema_version:2,intended_targets:['npm','github'],concluded:mode!=='verify',candidate_sha:plan.candidate_sha||env.CANDIDATE_SHA,analysis:env.ANALYSIS_STATUS==='success'&&typeof plan.release_needed==='boolean'?(plan.release_needed?'release':'no-release'):env.ANALYSIS_STATUS==='failure'?'failed':'unknown',version:plan.version??null,baseline_tag:plan.baseline_tag??null,enabled:env.RELEASE_ENABLED==='true',verification,targets,artifacts:plan.sha256?[{name:'final.tgz',sha256:plan.sha256}]:[],failure_stage:failure,recovery:read(join(cwd,'release-sealed/recovery.json')),errors:failure?[{message:`${failure} failed; inspect its Actions step`}]:[]},{summaryPath:null});
}
function validObservation(source){
 return object(source)&&object(source.targets)&&Object.values(source.targets).every(target=>object(target)&&['completed','failed','in-progress','not-run','unknown'].includes(target.status))
  &&(source.schema_version===undefined||[1,2].includes(source.schema_version))
  &&(source.candidate_sha===undefined||/^[a-f0-9]{40}$/.test(source.candidate_sha))
  &&(source.verification===undefined||['passed','failed','not-run'].includes(source.verification))
  &&(source.version===undefined||source.version===null||/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source.version))
  &&(source.observed_at===undefined||Number.isFinite(Date.parse(source.observed_at)))
  &&(source.artifacts===undefined||Array.isArray(source.artifacts))
  &&(source.errors===undefined||(Array.isArray(source.errors)&&source.errors.every(error=>typeof error==='string'||object(error))));
}
function observations(root,cwd,errors){return !existsSync(root)?[]:readdirSync(root).flatMap(name=>{const path=join(root,name);if(statSync(path).isDirectory())return observations(path,cwd,errors);if(name!=='release-result.json')return [];try{const source=read(path);if(!validObservation(source))throw Error('Invalid observation');return [source];}catch{errors.push({message:`Malformed observation: ${relative(cwd,path)}`});return [];}});}
export function finalStatus({cwd=process.cwd(),env=process.env}={}){
 const inputErrors=[];
 const sources=observations(join(cwd,'release-observations'),cwd,inputErrors);
 let input={candidate_sha:env.CANDIDATE_SHA,verification:'not-run',version:null,baseline_tag:null,artifacts:[],recovery:null};
 const targets={npm:{status:'not-run'},github:{status:'not-run'}};
 for(const source of sources){
  if(source.version||source.recovery||!input.baseline_tag)input={...input,...source};
  if(source.verification==='passed'&&input.verification!=='failed')input.verification='passed';
  for(const [name,target]of Object.entries(source.targets))if(target.status!=='not-run'&&targets[name]?.status!=='completed')targets[name]=source.schema_version===1&&target.status==='completed'?{...target,status:'unknown',reason:'Historical schema-v1 result cannot confirm publication'}:target;
 }
 let sealedDirectory='release-sealed';
 if(!existsSync(join(cwd,sealedDirectory,'final.json'))&&env.SOURCE_RUN_ID&&env.ARTIFACT_ID){
  const recovered='release-observations/recover/release-sealed';
  if(existsSync(join(cwd,recovered,'final.json')))try{
   const identity=read(join(cwd,recovered,'recovery.json'));
   if(!identity||String(identity.source_run_id)!==String(env.SOURCE_RUN_ID)||String(identity.artifact_id)!==String(env.ARTIFACT_ID))throw Error('Recovery identity mismatch');
   sealedDirectory=recovered;
  }catch{inputErrors.push({message:'Malformed observation: original recovery payload identity'});}
 }
 let plan;try{plan=read(join(cwd,sealedDirectory,'final.json'));if(plan!==null&&(!object(plan)||!/^[a-f0-9]{40}$/.test(plan.candidate_sha||'')||typeof plan.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plan.version)||(env.SOURCE_RUN_ID&&String(plan.source_run_id)!==String(env.SOURCE_RUN_ID))))throw Error('Invalid sealed manifest');if(plan)sealedTagFormat(plan);}catch{plan=null;inputErrors.push({message:`Malformed observation: ${sealedDirectory}/final.json`});}
 let inspected;
 const requested=env.SOURCE_RUN_ID||env.ARTIFACT_ID;
 const validIds=/^[1-9]\d*$/.test(env.SOURCE_RUN_ID||'')&&/^[1-9]\d*$/.test(env.ARTIFACT_ID||'');
 if(requested){
  input.recovery={available:false,...(validIds?{source_run_id:env.SOURCE_RUN_ID,artifact_id:env.ARTIFACT_ID}:{}),blocked_reason:validIds?'Original recovery evidence has not been verified':'Recovery requires positive original run and artifact IDs'};
  if(!plan&&validIds)try{
   inspected=inspectRecovery({cwd,env:{...process.env,...env}});plan=inspected.metadata;input.verification='passed';input.analysis='release';
  }catch(error){input.recovery.blocked_reason=error.message;}
 }
 if(plan){
  input={...input,candidate_sha:plan.candidate_sha,version:plan.version,baseline_tag:plan.baseline_tag};
  const observed=inspected?.publicationObservation??observeNpmGitHub({cwd,env:{...process.env,...env},plan,inputDirectory:sealedDirectory});
  targets.github=observed.targets.github;
  input.errors=[...(input.errors||[]),...observed.errors];
  const sourceRunId=env.SOURCE_RUN_ID||env.GITHUB_RUN_ID,artifactId=env.ARTIFACT_ID||env.SEALED_ARTIFACT_ID;
  if(inspected){
   input.recovery={source_run_id:sourceRunId,artifact_id:artifactId,...recoveryFromArtifact({plan,repository:env.GITHUB_REPOSITORY,sourceRunId,artifactId,run:inspected.run,artifact:inspected.artifact,publicationObservation:observed,recoveryArtifactPrefix:`release-receipts-${plan.candidate_sha}`})};
  }else if(sourceRunId&&artifactId&&(!requested||validIds)){try{
   const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:120000}));
   input.recovery={source_run_id:sourceRunId,artifact_id:artifactId,...recoveryFromArtifact({plan,repository:env.GITHUB_REPOSITORY,sourceRunId,artifactId,run:api(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`),artifact:api(`repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}`),publicationObservation:observed,allowCurrentRunId:env.GITHUB_RUN_ID,recoveryArtifactPrefix:`release-receipts-${plan.candidate_sha}`})};
  }catch(error){input.recovery={available:false,source_run_id:sourceRunId,artifact_id:artifactId,blocked_reason:error.message};}}
  else if(observed.recovery.state!=='repairable')input.recovery={...input.recovery,available:false,blocked_reason:observed.recovery.reason};
 }else{
  input.recovery={...input.recovery,available:false,blocked_reason:input.recovery?.blocked_reason||'The original sealed payload is unavailable or unverified'};
 }
 targets.npm=bindNpmReceipt(targets.npm,plan,cwd,sealedDirectory,inspected?.files);
 if(targets.npm.channel_blocked===true){
  input.recovery={...input.recovery,available:false,blocked_reason:'The latest registry channel is not confirmed; recovery preserves shared channels and cannot repair this gap automatically.'};
  delete input.recovery.command;
 }
 const failure=[['verification',env.VERIFY_JOB_STATUS],['release',env.RELEASE_JOB_STATUS],['recover',env.RECOVER_JOB_STATUS]].find(([,value])=>['failure','cancelled'].includes(value));
 if(failure?.[0]==='verification')input.verification='failed';
 return writeResult(join(cwd,'release-result.json'),{...input,schema_version:2,intended_targets:['npm','github'],concluded:true,publication:undefined,enabled:env.RELEASE_ENABLED==='true',targets,failure_stage:failure?.[0]||(inputErrors.length?'report-inputs':input.failure_stage)||null,errors:[...(input.errors||[]),...inputErrors,...(failure?[{message:`${failure[0]} job ${failure[1]}`}]:[])]});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='final')finalStatus();else reportStatus({mode:process.argv[2]});
}
