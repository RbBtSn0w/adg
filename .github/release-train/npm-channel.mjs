// Observe channel delivery independently of immutable package integrity.
import {spawnSync} from 'node:child_process';
export function validateLatestVersion(metadata,latestVersion){
 const tuple=value=>{if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error('npm latest channel version is unverifiable');return value.split('.').map(BigInt);};
 const expected=tuple(metadata.version),observed=tuple(latestVersion);
 for(let index=0;index<3;index++){if(observed[index]>expected[index])return latestVersion;if(observed[index]<expected[index])throw Error('npm latest channel is older than the sealed publication');}
 return latestVersion;
}
function readTags(metadata,{cwd=process.cwd(),env=process.env,registry='https://registry.npmjs.org'}={},allowAbsent=false){
 const result=spawnSync('npm',['view',metadata.name,'dist-tags','--json','--registry',registry],{cwd,env,encoding:'utf8',timeout:120000});
 if(result.error)throw result.error;
 if(result.status!==0){let error;try{error=JSON.parse(result.stdout)?.error;}catch{}if(allowAbsent&&error?.code==='E404')return null;throw Error('npm latest dist-tags readback failed');}
 let tags;try{tags=JSON.parse(result.stdout);}catch{throw Error('npm latest dist-tags readback was not valid JSON');}
 if(!tags||typeof tags!=='object'||Array.isArray(tags))throw Error('npm latest dist-tags readback was not an object');
 return tags;
}
export function verifyLatest(metadata,options){
 const tags=readTags(metadata,options);
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
 if(typeof format!=='string'||format.split('${version}').length!==2||format.replace('${version}',version)!==tag)throw Error('Original configured tag format differs from the sealed tag');
 return format;
}
