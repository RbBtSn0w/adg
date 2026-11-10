import {validateOriginalPlan} from './release-entrypoint.mjs';
// Read-only inspection of original immutable recovery evidence; never run payload code.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {inflateRawSync,crc32} from 'node:zlib';
import {verifyRecoverySource,verifyRecoveryArtifactRole} from './recovery-source.mjs';
import {observeGitHub,refineGitHubAssets} from './observe-github.mjs';
import {npmRequestState} from './npm-view.mjs';
import {sealedTagFormat} from './npm-channel.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateRecoveryPayload(metadata,archive){
 validateOriginalPlan(metadata);
 const bytes=Buffer.isBuffer(archive)?archive:readFileSync(archive);
 if(metadata.schema_version!==1||metadata.verification!=='passed'||metadata.release_needed!==true||metadata.operation!=='release')throw Error('Original verified release plan is required');
 if(!/^[a-f0-9]{40}$/.test(metadata.candidate_sha||'')||!/^\d+\.\d+\.\d+$/.test(metadata.version||'')||!metadata.tag||!metadata.name||typeof metadata.notes!=='string')throw Error('Invalid original release identity');
 if(metadata.sha256!==hash(bytes)||metadata.integrity!=='sha512-'+createHash('sha512').update(bytes).digest('base64'))throw Error('Original sealed archive digest mismatch');
 const manifest=JSON.parse(execFileSync('tar',['-xzOf','-','package/package.json'],{input:bytes,encoding:'utf8'}));
 if(manifest.name!==metadata.name||manifest.version!==metadata.version)throw Error('Sealed npm manifest differs');
 sealedTagFormat(metadata);
 return metadata;
}
export function selectRecoveryEntries(entries) {
  if (new Set(entries).size !== entries.length || entries.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw Error('Unsafe or duplicate recovery archive entry');
  const selected = {};
  for (const name of ['final.json', 'final.tgz']) {
    const matches = entries.filter(entry => entry === name || entry === `release-sealed/${name}`);
    if (matches.length !== 1) throw Error(`Recovery requires exactly one sealed ${name}`);
    selected[name] = matches[0];
  }
  const roots = new Set(Object.values(selected).map(entry => entry.includes('/') ? 'release-sealed' : ''));
  if (roots.size !== 1) throw Error('Ambiguous recovery payload root');
  const prefix=Object.values(selected)[0].startsWith('release-sealed/')?'release-sealed/':'';
  const receipt=`${prefix}receipts/npm.json`;
  if(entries.includes(receipt))selected['receipts/npm.json']=receipt;
  return selected;
}

function recoveryFiles(raw){
 let end=-1;for(let index=raw.length-22;index>=Math.max(0,raw.length-65557);index--)if(raw.readUInt32LE(index)===0x06054b50){end=index;break;}
 if(end<0||raw.readUInt16LE(end+4)!==0||raw.readUInt16LE(end+6)!==0||raw.readUInt16LE(end+8)!==raw.readUInt16LE(end+10))throw Error('Invalid original recovery ZIP');
 const records=new Map(),count=raw.readUInt16LE(end+10);let offset=raw.readUInt32LE(end+16);
 for(let index=0;index<count;index++){
  if(raw.readUInt32LE(offset)!==0x02014b50)throw Error('Invalid recovery ZIP directory');
  const length=raw.readUInt16LE(offset+28),extra=raw.readUInt16LE(offset+30),comment=raw.readUInt16LE(offset+32),name=raw.subarray(offset+46,offset+46+length).toString();
  if(records.has(name))throw Error('Unsafe or duplicate recovery archive entry');
  records.set(name,offset);offset+=46+length+extra+comment;
 }
 const selected=selectRecoveryEntries([...records.keys()]),files={};
 for(const [name,entry]of Object.entries(selected)){
  const central=records.get(entry),mode=raw.readUInt32LE(central+38)>>>16,local=raw.readUInt32LE(central+42),size=raw.readUInt32LE(central+24),compressed=raw.readUInt32LE(central+20),method=raw.readUInt16LE(central+10);
  if(size>100*1024*1024||(mode&0xf000)===0xa000||(mode&0xf000)===0x4000||(raw.readUInt16LE(central+8)&1)||raw.readUInt32LE(local)!==0x04034b50)throw Error('Recovery requires bounded regular data files');
  const start=local+30+raw.readUInt16LE(local+26)+raw.readUInt16LE(local+28),payload=raw.subarray(start,start+compressed);
  const bytes=method===0?payload:method===8?inflateRawSync(payload,{maxOutputLength:100*1024*1024}):null;
  if(!bytes||bytes.length!==size||start+compressed>raw.readUInt32LE(end+16)||crc32(bytes)!==raw.readUInt32LE(central+16))throw Error('Recovery ZIP bytes or checksum differ');
  files[name]=bytes;
 }
 return files;
}
function observeFiles({plan,files,repository,api,download,tagFormat,observation:existing}){
 const observation=existing??observeGitHub({plan,repository,read:api,tagFormat:tagFormat??sealedTagFormat(plan)});
 if(observation.recovery.state!=='repairable')return observation;
 try{
  if(hash(files['final.tgz'])!==plan.sha256)throw Error('Original sealed npm archive differs from its manifest checksum');
  const expectedAssets=Object.fromEntries(['final.tgz','final.json'].map(name=>[name,'sha256:'+hash(files[name])]));
  return refineGitHubAssets({observation,expectedAssets,readAsset:download});
 }catch(error){observation.targets.github={status:'unknown',reason:error.message};observation.errors.push(error.message);observation.recovery={...observation.recovery,state:'unknown',reason:error.message};return observation;}
}
export function observeNpmGitHub({cwd=process.cwd(),env=process.env,plan,inputDirectory='release-sealed',tagFormat}={}){
 const api=path=>JSON.parse(execFileSync('gh',['api',path],{cwd,env,encoding:'utf8',timeout:120000}));
 const observation=observeGitHub({plan,repository:env.GITHUB_REPOSITORY,read:api,tagFormat:tagFormat??sealedTagFormat(plan)});
 if(observation.recovery.state!=='repairable')return observation;
 let files;
 try{files=Object.fromEntries(['final.tgz','final.json'].map(name=>[name,readFileSync(resolve(cwd,inputDirectory,name))]));}
 catch(error){observation.targets.github={status:'unknown',reason:error.message};observation.errors.push(error.message);observation.recovery={...observation.recovery,state:'unknown',reason:error.message};return observation;}
 return observeFiles({plan,files,repository:env.GITHUB_REPOSITORY,api,tagFormat,observation,download:asset=>execFileSync('gh',['api',`repos/${env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{cwd,env,timeout:120000,maxBuffer:100*1024*1024})});
}
export function inspectRecovery({env=process.env,cwd=process.cwd()}={}){
 const repository=env.GITHUB_REPOSITORY,sourceRunId=env.SOURCE_RUN_ID,artifactId=env.ARTIFACT_ID;
 const command=(...args)=>execFileSync('gh',args,{cwd,env,timeout:120000,maxBuffer:100*1024*1024});
 const api=path=>JSON.parse(command('api',path));
 const run=api(`repos/${repository}/actions/runs/${sourceRunId}`),artifact=api(`repos/${repository}/actions/artifacts/${artifactId}`);
 const source=verifyRecoverySource({run,artifact,repository,sourceRunId,artifactId});
 source.source_attempt=verifyRecoveryArtifactRole({name:artifact.name,prefix:`release-receipts-${source.candidate_sha}`,runAttempt:run.run_attempt});
 const raw=command('api',`repos/${repository}/actions/artifacts/${artifactId}/zip`);
 if(!/^sha256:[a-f0-9]{64}$/.test(artifact.digest||'')||artifact.digest!=='sha256:'+hash(raw))throw Error('Original artifact download digest mismatch or unavailable');
 const files=recoveryFiles(raw),metadata=validateRecoveryPayload(JSON.parse(files['final.json']),files['final.tgz']);
 if(metadata.candidate_sha!==source.candidate_sha||metadata.repository!==repository||String(metadata.source_run_id)!==String(sourceRunId))throw Error('Original payload provenance mismatch');
 if(files['receipts/npm.json'])npmRequestState(metadata,JSON.parse(files['receipts/npm.json']));
 const publicationObservation=observeFiles({plan:metadata,files,repository,api,download:asset=>command('api',`repos/${repository}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream')});
 return {metadata,files,source,run,artifact,publicationObservation};
}
