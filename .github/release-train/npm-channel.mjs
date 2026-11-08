// Observe channel delivery independently of immutable package integrity.
import {spawnSync} from 'node:child_process';
export function validateLatestVersion(metadata,latestVersion){
 const tuple=value=>{if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error('npm latest channel version is unverifiable');return value.split('.').map(BigInt);};
 const expected=tuple(metadata.version),observed=tuple(latestVersion);
 for(let index=0;index<3;index++){if(observed[index]>expected[index])return latestVersion;if(observed[index]<expected[index])throw Error('npm latest channel is older than the sealed publication');}
 return latestVersion;
}
export function verifyLatest(metadata,{cwd=process.cwd(),env=process.env,registry='https://registry.npmjs.org'}={}){
 const result=spawnSync('npm',['view',metadata.name,'dist-tags','--json','--registry',registry],{cwd,env,encoding:'utf8',timeout:120000});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error('npm latest dist-tags readback failed');
 let tags;try{tags=JSON.parse(result.stdout);}catch{throw Error('npm latest dist-tags readback was not valid JSON');}
 if(!tags||typeof tags!=='object'||Array.isArray(tags))throw Error('npm latest dist-tags readback was not an object');
 return {latest_version:validateLatestVersion(metadata,tags.latest),observed_at:new Date().toISOString()};
}
