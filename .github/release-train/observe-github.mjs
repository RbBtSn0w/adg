// Remote readback, never workflow/job success, establishes channel completion.
import {execFileSync} from 'node:child_process';
import {verifyRecoverySource} from './recovery-source.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:120000}));
export function observeGitHub({plan,repository=process.env.GITHUB_REPOSITORY,read=api,observedAt=new Date().toISOString()}={}){
 const targets={stable_tag:{status:'unknown'},github:{status:'unknown'}};
 const errors=[];
 if(!repository||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))return {targets,errors:['Expected repository is required']};
 if(!plan||!/^[a-f0-9]{40}$/.test(plan.candidate_sha||'')||typeof plan.notes!=='string'||!/^v\d+\.\d+\.\d+$/.test(plan.tag||'')||plan.tag!==`v${plan.version}`)return {targets,errors:['Exact original plan identity is required']};
 const identity={candidate_sha:plan.candidate_sha,version:plan.version,observed_at:observedAt};
 try{
  const ref=read(`repos/${repository}/git/ref/tags/${encodeURIComponent(plan.tag)}`);
  if(ref.ref!==`refs/tags/${plan.tag}`)throw Error('Stable tag identity differs');
  let object=ref.object;const seen=new Set();
  while(object?.type==='tag'){
   if(seen.has(object.sha)||seen.size>=8)throw Error('Annotated tag chain is cyclic or excessive');
   seen.add(object.sha);object=read(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  if(object?.type!=='commit'||object.sha!==plan.candidate_sha)throw Error('Stable tag source differs from sealed candidate');
  targets.stable_tag={status:'completed',...identity,remote_id:plan.tag,url:`https://github.com/${repository}/releases/tag/${encodeURIComponent(plan.tag)}`};
  const release=read(`repos/${repository}/releases/tags/${encodeURIComponent(plan.tag)}`);
  if(!release?.id||release.tag_name!==plan.tag||release.draft!==false||release.prerelease!==false||release.body!==plan.notes)throw Error('Remote GitHub Release identity, notes or stable visibility differs');
  targets.github={status:'completed',...identity,remote_id:String(release.id),url:release.html_url||`https://github.com/${repository}/releases/tag/${encodeURIComponent(plan.tag)}`};
 }catch(error){errors.push(error.message);}
 return {targets,errors};
}
export function recoveryFromArtifact({plan,repository,sourceRunId,artifactId,run,artifact,tagVerified,workflow='.github/workflows/release.yml',allowCurrentRunId,recoveryArtifactPrefix}={}){
 try{
  if(tagVerified!==true)throw Error('Original stable tag has not been verified');
  const current=String(allowCurrentRunId||'')===String(sourceRunId)&&String(run?.id)===String(sourceRunId)&&run.status==='in_progress';
  const identity=verifyRecoverySource({run:current?{...run,status:'completed'}:run,artifact,repository,workflow,sourceRunId,artifactId});
  if(identity.candidate_sha!==plan.candidate_sha)throw Error('Original artifact candidate differs from sealed plan');
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=recoveryArtifactPrefix?new RegExp('^'+escape(recoveryArtifactPrefix)+'-([1-9]\\d*)$').exec(artifact.name||''):/^release-(?:plan|sealed)-([1-9]\d*)$/.exec(artifact.name||'');
  const sourceAttempt=match?Number(match[1]):['release-plan','release-sealed'].includes(artifact.name)?1:null;
  if(!sourceAttempt||sourceAttempt>run.run_attempt||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest||'')||!Number.isFinite(Date.parse(artifact.expires_at))||Date.parse(artifact.expires_at)<=Date.now())throw Error('Original sealed artifact role, digest, attempt or expiry is unavailable');
  return {...identity,available:true,wait_for_run_completion:current,tag_verified:true,digest:artifact.digest,source_attempt:sourceAttempt,expires_at:artifact.expires_at,workflow,role:artifact.name,command:`gh workflow run ${workflow.split('/').at(-1)} --repo ${repository} --ref main -f operation=recover -f source_run_id=${identity.source_run_id} -f artifact_id=${identity.artifact_id}`};
 }catch(error){return {available:false,blocked_reason:error.message};}
}
