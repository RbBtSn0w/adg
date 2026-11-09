import {parseNpmView,npmRequestState} from './npm-view.mjs';
// Observe channel delivery independently of immutable package integrity.
import {spawnSync} from 'node:child_process';
export function validateLatestVersion(metadata,latestVersion){
 const tuple=value=>{if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error('npm latest channel version is unverifiable');return value.split('.').map(BigInt);};
 const expected=tuple(metadata.version),observed=tuple(latestVersion);
 for(let index=0;index<3;index++){if(observed[index]>expected[index])return latestVersion;if(observed[index]<expected[index])throw Object.assign(Error('npm latest channel is older than the sealed publication'),{code:'NPM_CHANNEL_PENDING'});}
 return latestVersion;
}
function readTags(metadata,{cwd=process.cwd(),env=process.env,registry='https://registry.npmjs.org',timeout=120000}={},allowAbsent=false){
 const result=spawnSync('npm',['view',metadata.name,'dist-tags','--json','--registry',registry],{cwd,env,encoding:'utf8',timeout:Math.min(120000,timeout)});
 if(result.error)throw result.error;
 if(result.status!==0){let error;try{error=parseNpmView(result.stdout)?.error;}catch{}if(allowAbsent&&error?.code==='E404')return null;throw Error('npm latest dist-tags readback failed');}
 let tags;try{tags=parseNpmView(result.stdout);}catch(error){throw new Error(`npm latest dist-tags response could not be interpreted: ${error.message}`,{cause:error});}
 if(!tags||typeof tags!=='object'||Array.isArray(tags)||Object.values(tags).some(value=>typeof value!=='string'))throw Error('npm latest dist-tags readback was not an object with string values');
 return tags;
}
export function verifyLatest(metadata,options){
 const tags=readTags(metadata,options,true);
 if(tags?.latest===undefined)throw Object.assign(Error('npm latest channel is not yet visible'),{code:'NPM_CHANNEL_PENDING'});
 return {latest_version:validateLatestVersion(metadata,tags.latest),observed_at:new Date().toISOString()};
}
export function assertNoKnownNewerLatest(metadata,options){
 validateLatestVersion(metadata,metadata.version);
 const latest=readTags(metadata,options,true)?.latest;
 if(latest===undefined)return null;
 validateLatestVersion({version:latest},latest);
 try{validateLatestVersion({version:latest},metadata.version);}
 catch(error){throw new Error('Normal publication is blocked by a known newer latest channel',{cause:error});}
 return latest;
}

export function sealedTagFormat(metadata){
 const {version,tag}=metadata;
 if(typeof version!=='string'||!version||typeof tag!=='string')throw Error('Original sealed tag format is unverifiable');
 let format=metadata.tag_format;
 if(format===undefined){
  // Legacy plans still bind an exact engine-produced tag and version. Infer only
  // a single literal version position; ambiguous evidence cannot authorize repair.
  const index=tag.indexOf(version);
  if(index<0||tag.indexOf(version,index+1)>=0)throw Error('Original sealed tag format is unverifiable');
  format=tag.slice(0,index)+'${version}'+tag.slice(index+version.length);
 }
 if(typeof format!=='string')throw Error('Original configured tag format differs from the sealed tag');
 // Normalize only direct version interpolation. Never evaluate a template from
 // an artifact; expressions, evaluation blocks and escaping are not executable evidence.
 const tokens=format.match(/\$\{\s*version\s*\}|<%=\s*version\s*%>/g)||[];
 const canonical=format.replace(/\$\{\s*version\s*\}|<%=\s*version\s*%>/g,'${version}');
 const literal=canonical.replace('${version}','');
 if(tokens.length!==1||literal.includes('${')||literal.includes('<%'))throw Error('Unsupported tag template: only direct version interpolation is accepted');
 if(canonical.replace('${version}',version)!==tag)throw Error('Original configured tag format differs from the sealed tag');
 return canonical;
}

// Finalization consumes observations, never a job-success flag or request intent.
export function assertNpmReceiptConfirmed(metadata,receipt){
 npmRequestState(metadata,receipt);
 const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
 if(receipt?.status!=='completed'||receipt.bytes_verified!==true||receipt.channel_blocked===true
    ||(metadata.sha256!==undefined&&receipt.sha256!==metadata.sha256)
    ||!timestamp(receipt.observed_at)||!timestamp(receipt.channel_observed_at)
    ||(metadata.name?receipt.remote_id!==`${metadata.name}@${metadata.version}`:!receipt.remote_id))throw Error('Original registry receipt lacks confirmed payload and channel evidence');
 validateLatestVersion(metadata,receipt.latest_version);
 return receipt;
}
