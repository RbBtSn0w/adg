// Remote readback establishes both completion and whether original recovery is safe.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyRecoverySource,verifyRecoveryArtifactRole} from './recovery-source.mjs';
const api=path=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:120000}));
export function observeGitHub({plan,repository=process.env.GITHUB_REPOSITORY,read=api,observedAt=new Date().toISOString(),tagFormat='v${version}'}={}){
 const targets={stable_tag:{status:'unknown'},github:{status:'unknown'}},errors=[];
 const result={targets,errors,release:null,recovery:{state:'unknown',reason:'Publication has not been read back',repository,candidate_sha:plan?.candidate_sha,version:plan?.version,tag:plan?.tag,observed_at:observedAt}};
 const stop=(state,reason)=>{result.recovery.state=state;result.recovery.reason=reason;errors.push(reason);return result;};
 if(!repository||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))return stop('unknown','Expected repository is required');
 if(!plan||!/^[a-f0-9]{40}$/.test(plan.candidate_sha||'')||typeof plan.notes!=='string'||typeof tagFormat!=='string'||tagFormat.split('${version}').length!==2||plan.tag!==tagFormat.replace('${version}',plan.version)||!/^\d+\.\d+\.\d+$/.test(plan.version||''))return stop('unknown','Exact original plan identity is required');
 const identity={candidate_sha:plan.candidate_sha,version:plan.version,observed_at:observedAt};
 try{
  const ref=read(`repos/${repository}/git/ref/tags/${encodeURIComponent(plan.tag)}`);
  if(ref.ref!==`refs/tags/${plan.tag}`)return stop('conflict','Stable tag identity differs');
  let object=ref.object;const seen=new Set();
  while(object?.type==='tag'){
   if(seen.has(object.sha)||seen.size>=8)return stop('conflict','Annotated tag chain is cyclic or excessive');
   seen.add(object.sha);object=read(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  if(object?.type!=='commit'||object.sha!==plan.candidate_sha)return stop('conflict','Stable tag source differs from sealed candidate');
  targets.stable_tag={status:'completed',...identity,remote_id:plan.tag,url:`https://github.com/${repository}/releases/tag/${encodeURIComponent(plan.tag)}`};
  let release;
  try{release=read(`repos/${repository}/releases/tags/${encodeURIComponent(plan.tag)}`);}
  catch{
   // A failed tag lookup is not absence. Independently read every listing page,
   // including drafts, before allowing creation of a missing original Release.
   const matches=[];
   for(let page=1;page<=1000;page++){
    const entries=read(`repos/${repository}/releases?per_page=100&page=${page}`);
    if(!Array.isArray(entries)||entries.some(item=>!item||typeof item.tag_name!=='string'))throw Error('Release listing is unverifiable');
    matches.push(...entries.filter(item=>item.tag_name===plan.tag));
    if(entries.length<100)break;
    if(page===1000)throw Error('Release listing exceeds the bounded readback');
   }
   if(matches.length>1)return stop('conflict','Ambiguous original GitHub Release identity');
   if(!matches.length){result.recovery={...result.recovery,state:'repairable',reason:'Original Release is absent after complete readback'};return result;}
   release=matches[0];
  }
  result.release=release;
  if(release?.tag_name!==plan.tag||release?.body!==plan.notes||release?.prerelease===true)return stop('conflict','Remote GitHub Release identity, notes or stable channel differs');
  if(!/^[1-9]\d*$/.test(String(release?.id||''))||release.prerelease!==false||typeof release.draft!=='boolean')return stop('unknown','Remote GitHub Release identity or visibility is unverifiable');
  result.recovery={...result.recovery,state:'repairable',reason:release.draft?'Matching original draft can be completed':'Original Release content matches'};
  if(!release.draft)targets.github={status:'completed',...identity,remote_id:String(release.id),url:release.html_url||`https://github.com/${repository}/releases/tag/${encodeURIComponent(plan.tag)}`};
 }catch(error){return stop('unknown',error.message);}
 return result;
}

export function refineGitHubAssets({observation,expectedAssets,readAsset}={}){
 const result=structuredClone(observation);
 if(result?.recovery?.state!=='repairable')return result;
 const stop=(state,reason)=>{result.recovery={...result.recovery,state,reason};result.targets.github={status:'unknown',reason};result.errors.push(reason);return result;};
 if(!expectedAssets||!Object.keys(expectedAssets).length||Object.values(expectedAssets).some(digest=>!/^sha256:[a-f0-9]{64}$/.test(digest)))return stop('unknown','Original expected asset digests are unavailable');
 if(!result.release)return result; // Proven missing Release is repairable as a whole.
 if(!Array.isArray(result.release.assets))return stop('unknown','GitHub release assets could not be read back');
 let missing=false;
 for(const [name,digest]of Object.entries(expectedAssets)){
  const matches=result.release.assets.filter(asset=>asset.name===name);
  if(matches.length>1)return stop('conflict',`GitHub asset is duplicated: ${name}`);
  if(!matches.length){missing=true;continue;}
  const asset=matches[0];
  if(!/^[1-9]\d*$/.test(String(asset.id||'')))return stop('unknown',`GitHub asset identity is unverifiable: ${name}`);
  if(asset.digest){if(asset.digest!==digest)return stop('conflict',`GitHub asset checksum differs from original sealed bytes: ${name}`);}
  else{
   try{if(!readAsset)throw Error('Read-only asset byte reader is unavailable');const bytes=readAsset(asset);if('sha256:'+createHash('sha256').update(bytes).digest('hex')!==digest)return stop('conflict',`GitHub asset bytes differ from original sealed payload: ${name}`);}
   catch(error){return stop('unknown',`GitHub asset readback failed for ${name}: ${error.message}`);}
  }
 }
 if(missing){result.targets.github={status:'unknown',reason:'Original GitHub assets are missing'};result.recovery.reason='Missing original GitHub assets can be restored';}
 else if(result.targets.github.status==='completed')result.targets.github.checksums=structuredClone(expectedAssets);
 return result;
}
export function recoveryFromArtifact({plan,repository,sourceRunId,artifactId,run,artifact,publicationObservation,workflow='.github/workflows/release.yml',allowCurrentRunId,recoveryArtifactPrefix}={}){
 try{
  const proof=publicationObservation?.recovery;
  if(proof?.state!=='repairable')throw Error(proof?.reason||'GitHub publication recovery eligibility is unknown');
  if(proof.repository?.toLowerCase()!==repository?.toLowerCase()||proof.candidate_sha!==plan.candidate_sha||proof.version!==plan.version||proof.tag!==plan.tag||!Number.isFinite(Date.parse(proof.observed_at))||publicationObservation.targets?.stable_tag?.status!=='completed'||publicationObservation.targets.stable_tag.candidate_sha!==plan.candidate_sha)throw Error('GitHub recovery observation does not prove the original publication identity');
  const current=String(allowCurrentRunId||'')===String(sourceRunId)&&String(run?.id)===String(sourceRunId)&&run.status==='in_progress';
  const identity=verifyRecoverySource({run:current?{...run,status:'completed'}:run,artifact,repository,workflow,sourceRunId,artifactId});
  if(identity.candidate_sha!==plan.candidate_sha)throw Error('Original artifact candidate differs from sealed plan');
  const role=recoveryArtifactPrefix||['release-plan','release-sealed'].find(prefix=>artifact.name===prefix||artifact.name?.startsWith(prefix+'-'));
  const legacy=!recoveryArtifactPrefix&&['release-plan','release-sealed'].includes(artifact.name);
  const sourceAttempt=verifyRecoveryArtifactRole({name:legacy?`${artifact.name}-1`:artifact.name,prefix:role,runAttempt:run.run_attempt});
  if(!sourceAttempt||sourceAttempt>run.run_attempt||!/^sha256:[a-f0-9]{64}$/.test(artifact.digest||'')||!Number.isFinite(Date.parse(artifact.expires_at))||Date.parse(artifact.expires_at)<=Date.now())throw Error('Original sealed artifact role, digest, attempt or expiry is unavailable');
  return {...identity,available:true,wait_for_run_completion:current,tag_verified:true,digest:artifact.digest,source_attempt:sourceAttempt,expires_at:artifact.expires_at,workflow,role:artifact.name,command:`gh workflow run ${workflow.split('/').at(-1)} --repo ${repository} --ref main -f operation=recover -f source_run_id=${identity.source_run_id} -f artifact_id=${identity.artifact_id}`};
 }catch(error){return {available:false,blocked_reason:error.message};}
}
