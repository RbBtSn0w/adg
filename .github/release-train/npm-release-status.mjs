import {existsSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeResult} from './release-result.mjs';
import {observeGitHub,recoveryFromArtifact} from './observe-github.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
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
  targets[name]=receipt||{status:failure&&verification==='passed'&&!unknown?'unknown':'not-run'};
  if(targets[name].status==='unknown')unknown=true;
 }
 return writeResult(join(cwd,'release-result.json'),{schema_version:2,intended_targets:['npm','github'],concluded:mode!=='verify',candidate_sha:plan.candidate_sha||env.CANDIDATE_SHA,analysis:env.ANALYSIS_STATUS==='success'&&typeof plan.release_needed==='boolean'?(plan.release_needed?'release':'no-release'):env.ANALYSIS_STATUS==='failure'?'failed':'unknown',version:plan.version??null,baseline_tag:plan.baseline_tag??null,enabled:env.RELEASE_ENABLED==='true',verification,targets,artifacts:plan.sha256?[{name:'final.tgz',sha256:plan.sha256}]:[],failure_stage:failure,recovery:read(join(cwd,'release-sealed/recovery.json')),errors:failure?[{message:`${failure} failed; inspect its Actions step`}]:[]},{summaryPath:null});
}
function observations(root){return !existsSync(root)?[]:readdirSync(root).flatMap(name=>{const path=join(root,name);return statSync(path).isDirectory()?observations(path):name==='release-result.json'?[read(path)]:[];});}
// npm's GitHub target includes the immutable payloads, beyond tag/release identity.
export function observeNpmGitHub({cwd=process.cwd(),env=process.env,plan}={}){
 const api=path=>JSON.parse(execFileSync('gh',['api',path],{cwd,env,encoding:'utf8',timeout:120000}));
 const observed=observeGitHub({plan,repository:env.GITHUB_REPOSITORY,read:api});
 if(observed.targets.github.status!=='completed')return observed;
 try{
  const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
  const expected=Object.fromEntries(['final.tgz','final.json'].map(name=>[name,checksum(readFileSync(join(cwd,'release-sealed',name)))]));
  if(expected['final.tgz']!==plan.sha256)throw Error('Original sealed npm archive differs from its manifest checksum');
  const release=api(`repos/${env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(plan.tag)}`);
  if(String(release.id)!==observed.targets.github.remote_id||release.tag_name!==plan.tag||release.body!==plan.notes||release.draft!==false||release.prerelease!==false)throw Error('GitHub release identity changed during asset readback');
  if(!Array.isArray(release.assets))throw Error('GitHub release assets could not be read back');
  for(const [name,digest]of Object.entries(expected)){
   const matches=release.assets.filter(asset=>asset.name===name);
   if(matches.length!==1||!/^[1-9]\d*$/.test(String(matches[0].id||'')))throw Error(`GitHub asset missing or ambiguous: ${name}`);
   const asset=matches[0];
   if(asset.digest){if(asset.digest!==`sha256:${digest}`)throw Error(`GitHub asset checksum differs from original sealed bytes: ${name}`);}
   else{
    const bytes=execFileSync('gh',['api',`repos/${env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{cwd,env,timeout:120000,maxBuffer:100*1024*1024});
    if(checksum(bytes)!==digest)throw Error(`GitHub asset bytes differ from original sealed payload: ${name}`);
   }
  }
  observed.targets.github.checksums=expected;
 }catch(error){observed.targets.github={status:'unknown',reason:error.message};observed.errors.push(error.message);}
 return observed;
}
export function finalStatus({cwd=process.cwd(),env=process.env}={}){
 const sources=observations(join(cwd,'release-observations'));
 let input={candidate_sha:env.CANDIDATE_SHA,verification:'not-run',version:null,baseline_tag:null,artifacts:[],recovery:null};
 const targets={npm:{status:'not-run'},github:{status:'not-run'}};
 for(const source of sources){
  if(source.version||source.recovery||!input.baseline_tag)input={...input,...source};
  if(source.verification==='passed'&&input.verification!=='failed')input.verification='passed';
  for(const [name,target]of Object.entries(source.targets))if(target.status!=='not-run'&&targets[name]?.status!=='completed')targets[name]=source.schema_version===1&&target.status==='completed'?{...target,status:'unknown',reason:'Historical schema-v1 result cannot confirm publication'}:target;
 }
 const plan=read(join(cwd,'release-sealed/final.json'));
 if(plan){
  input={...input,candidate_sha:plan.candidate_sha,version:plan.version,baseline_tag:plan.baseline_tag};
  const observed=observeNpmGitHub({cwd,env:{...process.env,...env},plan});
  targets.github=observed.targets.github;
  input.errors=[...(input.errors||[]),...observed.errors];
  const sourceRunId=env.SOURCE_RUN_ID||env.GITHUB_RUN_ID,artifactId=env.ARTIFACT_ID||env.SEALED_ARTIFACT_ID;
  if(sourceRunId&&artifactId){try{
   const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:120000}));
   input.recovery=recoveryFromArtifact({plan,repository:env.GITHUB_REPOSITORY,sourceRunId,artifactId,run:api(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`),artifact:api(`repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}`),tagVerified:observed.targets.stable_tag.status==='completed',allowCurrentRunId:env.GITHUB_RUN_ID,recoveryArtifactPrefix:`release-receipts-${plan.candidate_sha}`});
  }catch(error){input.recovery={available:false,blocked_reason:error.message};}}
 }
 const failure=[['verification',env.VERIFY_JOB_STATUS],['release',env.RELEASE_JOB_STATUS],['recover',env.RECOVER_JOB_STATUS]].find(([,value])=>['failure','cancelled'].includes(value));
 if(failure?.[0]==='verification')input.verification='failed';
 return writeResult(join(cwd,'release-result.json'),{...input,schema_version:2,intended_targets:['npm','github'],concluded:true,publication:undefined,enabled:env.RELEASE_ENABLED==='true',targets,failure_stage:failure?.[0]||input.failure_stage||null,errors:failure?[{message:`${failure[0]} job ${failure[1]}`}]:input.errors||[]});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='final')finalStatus();else reportStatus({mode:process.argv[2]});
}
