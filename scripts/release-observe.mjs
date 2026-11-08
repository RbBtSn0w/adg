// Read-only GitHub preflight shared by recovery and recovery instructions.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {observeGitHub,refineGitHubAssets} from '../.github/release-train/observe-github.mjs';
export function observeRelease({metadata,notes,input='release-input',expectedAssets,env=process.env}={}){
 const repository=metadata.repository||env.GITHUB_REPOSITORY;
 const read=path=>JSON.parse(execFileSync('gh',['api',path],{env,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024}));
 const observation=observeGitHub({plan:{...metadata,notes},repository,read,tagFormat:metadata.tag===metadata.version?'${version}':'v${version}'});
 try{
  const expected=expectedAssets||Object.fromEntries(['final.tgz','final.json'].map(name=>[name,'sha256:'+createHash('sha256').update(readFileSync(join(input,name))).digest('hex')]));
  if(expected['final.tgz']!==`sha256:${metadata.sha256}`||!/^sha256:[a-f0-9]{64}$/.test(expected['final.json']||''))throw Error('Original sealed asset identities are unavailable or inconsistent');
  return refineGitHubAssets({observation,expectedAssets:expected,readAsset:asset=>execFileSync('gh',['api',`repos/${repository}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{env,timeout:120000,maxBuffer:100*1024*1024})});
 }catch(error){return {...observation,errors:[...observation.errors,error.message],recovery:{...observation.recovery,state:'unknown',reason:error.message}};}
}
