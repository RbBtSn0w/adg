// Recovery may restore immutable bytes under its own tag; channel aliases are read-only.
import {spawnSync} from 'node:child_process';
import {verifyLatest} from './npm-channel.mjs';
function tags(metadata,{cwd,env,registry}){
 const result=spawnSync('npm',['view',metadata.name,'dist-tags','--json','--registry',registry],{cwd,env,encoding:'utf8',timeout:120000});
 if(result.error)throw result.error;
 let value;try{value=JSON.parse(result.stdout);}catch{throw Error('npm dist-tags lookup was not valid JSON');}
 if(result.status!==0){if(value?.error?.code==='E404')return {};throw Error('npm dist-tags lookup failed');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('npm dist-tags lookup was not an object');
 return value;
}
export function recoveryTag(metadata,options){
 if(!/^[1-9]\d*$/.test(String(metadata.source_run_id||'')))throw Error('Recovery tag requires original source run identity');
 const tag=`recovery-${metadata.source_run_id}`,current=tags(metadata,options);
 if(current[tag]&&current[tag]!==metadata.version)throw Error('Original recovery tag now belongs to another version');
 return tag;
}
export function cleanRecoveryTag(metadata,tag,_options){
 if(!/^[1-9]\d*$/.test(String(metadata.source_run_id||'')))throw Error('Recovery tag requires original source run identity');
 if(tag!==`recovery-${metadata.source_run_id}`)throw Error('Refusing to remove an unrelated distribution tag');
 // Retain this compatibility hook without deletion: npm offers no conditional
 // delete, so an earlier matching read cannot protect a concurrent retarget.
 return false;
}
export function reconcileLatest(metadata,options){
 // Equal/newer channels are observed; missing or older aliases stay incomplete.
 // Recovery cannot atomically promote a tag without risking an external writer.
 return verifyLatest(metadata,options).latest_version;
}
