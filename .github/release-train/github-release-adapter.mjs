// Guard semantic-release's actual decision before it can create any tag or release.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeResult} from './release-result.mjs';
import {join} from 'node:path';
import {observeGitHub,recoveryFromArtifact} from './observe-github.mjs';
import {execFileSync} from 'node:child_process';
function planFor({env=process.env,cwd=process.cwd()}) {
  if(env.RELEASE_PLAN_REQUIRED!=='true') return null;
  const plan=JSON.parse(readFileSync(join(cwd,'release-plan.json'),'utf8'));
  if(plan.schema_version!==1||plan.verification!=='passed'||plan.release_needed!==true) throw new Error('Publication requires the sealed verified release plan');
  return plan;
}
export function verifyRelease(_options,context) {
  const plan=planFor(context);
  if(!plan)return;
  if(context.nextRelease.gitHead!==plan.candidate_sha||context.nextRelease.version!==plan.version||context.nextRelease.gitTag!==plan.tag)
    throw new Error('Semantic-release decision differs from sealed candidate/version/tag');
}
export function prepare(_options,context) {
  verifyRelease(_options,context);
  const plan=planFor(context);
  if(plan&&context.nextRelease.notes!==plan.notes) throw new Error('Release notes changed after analysis; analyze and verify a fresh plan');
}

export function sealPlan({cwd=process.cwd(),env=process.env}={}) {
  const path=join(cwd,'release-plan.json');
  const plan=JSON.parse(readFileSync(path,'utf8'));
  if(env.PRODUCT_CHECK_STATUS!=='success'||plan.candidate_sha!==env.CANDIDATE_SHA||plan.release_needed!==true)
    throw new Error('Seal requires successful product checks for the exact original candidate');
  plan.verification='passed';
  writeFileSync(path,JSON.stringify(plan,null,2)+'\n');
  return plan;
}
export function reportStatus({cwd=process.cwd(),env=process.env,extraTargets={}}={}) {
  const path=join(cwd,'release-plan.json');
  let plan={},readError=null;
  try {if(existsSync(path))plan=JSON.parse(readFileSync(path,'utf8'));}
  catch(error){readError=`Release plan artifact could not be read: ${error.message}`;}
  if(env.PLAN_DOWNLOAD_STATUS==='failure'||env.RECOVERY_PLAN_DOWNLOAD_STATUS==='failure')
    readError='Release plan artifact download failed; original publication identity is unavailable.';
  if(!plan.candidate_sha&&(env.PLAN_DOWNLOAD_STATUS==='success'||env.RECOVERY_PLAN_DOWNLOAD_STATUS==='success'))
    readError='Release plan artifact did not contain a readable candidate plan.';
  const recovered=env.RECOVERY_STATUS==='success';
  const failed=env.ANALYSIS_STATUS==='failure'||env.PRODUCT_CHECK_STATUS==='failure';
  const verified=(recovered&&Boolean(plan.candidate_sha))||env.PRODUCT_CHECK_STATUS==='success'||(env.ANALYSIS_STATUS==='success'&&plan.release_needed===false);
  const observation=readError?{targets:{stable_tag:{status:'unknown'},github:{status:'unknown'}},errors:[]}:plan.release_needed?observeGitHub({plan,repository:env.GITHUB_REPOSITORY}):{targets:{stable_tag:{status:'not-run'},github:{status:'not-run'}},errors:[]};
  let recovery={available:false,blocked_reason:'Original sealed producer artifact is unavailable'};
  const sourceRunId=env.SOURCE_RUN_ID||env.GITHUB_RUN_ID,artifactId=env.ARTIFACT_ID||env.SEALED_ARTIFACT_ID;
  if(plan.candidate_sha&&sourceRunId&&artifactId){
    try{
      const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:120000}));
      recovery=recoveryFromArtifact({plan,repository:env.GITHUB_REPOSITORY,sourceRunId,artifactId,run:api(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`),artifact:api(`repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}`),publicationObservation:observation,allowCurrentRunId:env.GITHUB_RUN_ID});
    }catch(error){recovery={available:false,blocked_reason:error.message};}
  }
  return writeResult(join(cwd,'release-result.json'),{schema_version:2,candidate_sha:plan.candidate_sha||env.CANDIDATE_SHA,
    analysis:env.ANALYSIS_STATUS==='success'&&typeof plan.release_needed==='boolean'?(plan.release_needed?'release':'no-release'):env.ANALYSIS_STATUS==='failure'?'failed':'unknown',version:plan.version??null,baseline_tag:plan.baseline_tag??null,enabled:env.RELEASE_ENABLED==='true',
    verification:failed?'failed':verified?'passed':'not-run',intended_targets:['stable_tag','github',...Object.keys(extraTargets)],concluded:true,
    targets:{...observation.targets,...extraTargets},
    failure_stage:readError?'artifact-read':failed?'verification':env.RELEASE_STATUS==='failure'?'github-publication':env.RECOVERY_STATUS==='failure'?'recovery':null,
    artifacts:[],recovery,errors:[...(readError?[readError]:[]),...observation.errors]},
    {summaryPath:env.GITHUB_STEP_SUMMARY});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='seal')sealPlan();
  else if(process.argv[2]==='status')reportStatus();
  else throw new Error('Usage: github-release-adapter.mjs seal | status');
}
