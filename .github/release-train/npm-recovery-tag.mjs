// Recovery uploads under an owned tag before explicitly reconciling stable latest.
import {execFileSync,spawnSync} from 'node:child_process';
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
export function cleanRecoveryTag(metadata,tag,options){
 if(tag!==`recovery-${metadata.source_run_id}`)throw Error('Refusing to remove an unrelated distribution tag');
 if(tags(metadata,options)[tag]!==metadata.version)return false;
 execFileSync('npm',['dist-tag','rm',metadata.name,tag,'--registry',options.registry],{cwd:options.cwd,env:options.env,stdio:'inherit',timeout:120000});
 return true;
}
export function reconcileLatest(metadata,options){
 const tuple=value=>{
  if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw Error('Stable latest version is unverifiable; refusing to overwrite it');
  return value.split('.').map(BigInt);
 };
 const expected=tuple(metadata.version);
 const compare=value=>{const observed=tuple(value);for(let i=0;i<3;i++){if(observed[i]>expected[i])return 1;if(observed[i]<expected[i])return -1;}return 0;};
 let latest=tags(metadata,options).latest;
 if(latest!==undefined&&compare(latest)>=0)return latest;
 // All participating release/recovery jobs share release-main. External manual
 // writers are outside that lock; re-read after the write and never claim an
 // unverifiable registry channel is complete.
 execFileSync('npm',['dist-tag','add',`${metadata.name}@${metadata.version}`,'latest','--registry',options.registry],{cwd:options.cwd,env:options.env,stdio:'inherit',timeout:120000});
 latest=tags(metadata,options).latest;
 if(latest===undefined||compare(latest)<0)throw Error('Stable latest restoration could not be verified');
 return latest;
}
