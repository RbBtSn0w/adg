import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
export function runRecovery(mode='missing-assets', tag='v2.0.0') {
 const cwd=mkdtempSync(join(tmpdir(),'release-recovery-flow-'));
 const input=join(cwd,'sealed');mkdirSync(input);mkdirSync(join(cwd,'package'));mkdirSync(join(cwd,'bin'));
 writeFileSync(join(cwd,'package/package.json'),JSON.stringify({name:'@scope/public-fixture',version:'2.0.0',scripts:{build:'exit 99'}}));
 execFileSync('tar',['-czf',join(input,'final.tgz'),'-C',cwd,'package']);
 const original=readFileSync(join(input,'final.tgz'));const digest=algorithm=>createHash(algorithm).update(original).digest(algorithm==='sha512'?'base64':'hex');
 const metadata={name:'@scope/public-fixture',version:'2.0.0',tag,tag_format:tag==='v2.0.0'?'v${version}':'release-${version}',candidate_sha:'a'.repeat(40),repository:'owner/repo',source_run_id:'12',operation:'release',sha256:digest('sha256'),integrity:'sha512-'+digest('sha512')};
 writeFileSync(join(input,'final.json'),JSON.stringify(metadata));writeFileSync(join(input,'analysis.json'),JSON.stringify({...metadata,notes:'Original release notes'}));

 mkdirSync(join(input,'receipts'));
 for(const target of ['npm','github-packages'])writeFileSync(join(input,`receipts/${target}.json`),JSON.stringify({...metadata,status:'not-run'}));

 if(['accepted-request','uncertain-request','receipt-conflict'].includes(mode))writeFileSync(join(input,'receipts/npm.json'),JSON.stringify({...metadata,status:'unknown',request_started_at:'2026-11-09T01:00:00Z',...(mode==='accepted-request'?{publication_accepted:true,accepted_at:'2026-11-09T01:00:00Z'}:{}),...(mode==='receipt-conflict'?{sha256:'f'.repeat(64)}:{})}));
 execFileSync('zip',['-q',join(cwd,'original.zip'),'final.tgz','final.json','analysis.json',...(mode==='receipt-missing'?[]:['receipts/npm.json','receipts/github-packages.json'])],{cwd:input});
 const zipDigest='sha256:'+createHash('sha256').update(readFileSync(join(cwd,'original.zip'))).digest('hex');
 writeFileSync(join(cwd,'artifact.json'),JSON.stringify({id:34,expired:false,expires_at:'2099-01-01T00:00:00Z',name:'release-receipts-'+metadata.candidate_sha+'-'+({'role-extra':'1-extra','role-zero':'0','role-future':'999','role-unsafe':'9007199254740993'}[mode]||'1'),digest:zipDigest,workflow_run:{id:12,head_sha:metadata.candidate_sha}}));
 writeFileSync(join(cwd,'run.json'),JSON.stringify({id:12,repository:{full_name:'owner/repo'},path:'.github/workflows/release.yml',head_branch:'main',head_sha:metadata.candidate_sha,event:'schedule',status:'completed',run_attempt:2}));
 writeFileSync(join(cwd,'bin/gh'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');const args=process.argv.slice(2),state=process.env.STATE,mode=process.env.REMOTE_MODE;
const read=name=>fs.readFileSync(path.join(state,name));
function release(){const mutated=fs.existsSync(path.join(state,'draft-published'));return {id:mode==='mutation-id'&&mutated?78:77,tag_name:'${metadata.tag}',body:(mode==='notes-conflict'||mode==='mutation-notes'&&mutated)?'Conflicting notes':'Original release notes',prerelease:mode==='mutation-channel'&&mutated,draft:!fs.existsSync(path.join(state,'draft-published')),assets:['final.tgz','final.json'].filter(name=>fs.existsSync(path.join(state,'uploaded-'+name))).map((name,index)=>({id:index+101,name,digest:'sha256:'+(mode==='asset-conflict'?'f'.repeat(64):crypto.createHash('sha256').update(read('uploaded-'+name)).digest('hex'))})),html_url:'https://github.com/owner/repo/releases/tag/${metadata.tag}'};}
if(args[0]==='api') {
 const url=args[1];
 if(url.includes('/actions/artifacts?name=release-recovery-intent-12-34'))console.log(JSON.stringify([{artifacts:[{id:78,name:'release-recovery-intent-12-34',expired:false,workflow_run:{id:56}},...(mode==='prior-recovery-request'?[{id:77,name:'release-recovery-intent-12-34',expired:false,workflow_run:{id:55}}]:[])]}]));
 else if(url.endsWith('/runs/12')){if(mode==='stale-source-read-error'){console.error('original run unavailable');process.exit(22);}process.stdout.write(read('run.json'));}
 else if(url.endsWith('/artifacts/34'))process.stdout.write(read('artifact.json'));
 else if(url.endsWith('/artifacts/34/zip'))process.stdout.write(read('original.zip'));
 else if(url.includes('/git/ref/tags/')){if(mode==='early-tag-read-error'&&!fs.existsSync(path.join(state,'tag-error-seen'))){fs.writeFileSync(path.join(state,'tag-error-seen'),'true');process.exit(22);}console.log(JSON.stringify({ref:'refs/tags/${metadata.tag}',object:{type:'commit',sha:'a'.repeat(40)}}));}
 else if(url.endsWith('/releases')||url.includes('/releases?')||url.includes('/releases/tags/')){
  if(mode==='read-error'||mode==='stale-github-read-error'){console.error('readback unavailable');process.exit(22);}
  const absent=mode==='missing-release'&&!fs.existsSync(path.join(state,'release-created'));
  if(url.includes('/releases?'))console.log(JSON.stringify(absent?[]:[release()]));else if(url.endsWith('/releases'))console.log(JSON.stringify([absent?[]:[release()]]));
  else if(absent){console.error('HTTP 404');process.exit(1);}else console.log(JSON.stringify(release()));
 }else {console.error('unexpected API '+url);process.exit(99);}
}else if(args[0]==='release'&&args[1]==='upload')fs.copyFileSync(args[3],path.join(state,'uploaded-'+path.basename(args[3])));
else if(args[0]==='release'&&args[1]==='create')fs.writeFileSync(path.join(state,'release-created'),'true');
else if(args[0]==='release'&&args[1]==='download'){const dir=args[args.indexOf('--dir')+1],name=args[args.indexOf('--pattern')+1];fs.copyFileSync(path.join(state,'uploaded-'+name),path.join(dir,name));}
else if(args[0]==='release'&&args[1]==='edit'&&args.includes('--draft=false')){fs.writeFileSync(path.join(state,'draft-edit-args.json'),JSON.stringify(args));fs.writeFileSync(path.join(state,'draft-published'),'true');}
else {console.error('unexpected write '+args);process.exit(99);}
`,{mode:0o755});
 if(['asset-conflict','matching-draft'].includes(mode))for(const name of ['final.tgz','final.json'])writeFileSync(join(cwd,'uploaded-'+name),readFileSync(join(input,name)));

 if(['accepted-request','uncertain-request','prior-recovery-request'].includes(mode))writeFileSync(join(cwd,'npm.tgz'),original);
 if(mode==='prior-recovery-request')writeFileSync(join(cwd,'mirror.tgz'),original);
 writeFileSync(join(cwd,'bin/npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const state=process.env.STATE,marker=path.join(state,args.at(-1).includes('github')?'mirror.tgz':'npm.tgz');const metadata=JSON.parse(fs.readFileSync(path.join(state,'release-input/final.json')));
if(args[0]==='view'&&args[2]==='dist-tags'){const tag='recovery-12';console.log(JSON.stringify({...(process.env.REMOTE_MODE==='channel-missing'?{}:{latest:(process.env.REMOTE_MODE==='channel-older'||process.env.REMOTE_MODE==='channel-npm-only'&&!args.at(-1).includes('github'))?'1.0.0':'9.0.0'}),...(fs.existsSync(marker+'.tag')?{[tag]:'2.0.0'}:{})}));}
else if(args[0]==='view'){if(['accepted-request','uncertain-request','prior-recovery-request'].includes(process.env.REMOTE_MODE)&&!args.at(-1).includes('github')&&!fs.existsSync(marker+'.observed')){fs.writeFileSync(marker+'.observed','true');console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}if(process.env.REMOTE_MODE==='registry-bytes-conflict'){console.log(JSON.stringify('sha512-conflicting'));process.exit(0);}if(process.env.REMOTE_MODE==='registry-read-error'){console.error('package identity unavailable');process.exit(22);}if(!fs.existsSync(marker)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify(metadata.integrity));}
else if(args[0]==='publish'){fs.appendFileSync(path.join(state,'registry-writes.jsonl'),JSON.stringify(args)+'\\n');const tag=args[args.indexOf('--tag')+1];if(!tag.startsWith('recovery-')){console.error('recovery must preserve newer latest');process.exit(97);}fs.copyFileSync(args[1],marker);fs.writeFileSync(marker+'.tag',tag);}
else if(args[0]==='dist-tag'&&args[1]!=='rm'){fs.appendFileSync(path.join(state,'channel-mutations.jsonl'),JSON.stringify(args)+'\\n');process.exit(98);}
else if(args[0]==='dist-tag'&&args[1]==='rm'&&args[3]==='recovery-12'){fs.appendFileSync(path.join(state,'channel-mutations.jsonl'),JSON.stringify(args)+'\\n');fs.unlinkSync(marker+'.tag');}
else process.exit(98);
`,{mode:0o755});
 for(const command of ['git','npx'])writeFileSync(join(cwd,'bin',command),'#!/bin/sh\nexit 99\n',{mode:0o755});
 if(mode==='stale-github-read-error'||mode==='stale-source-read-error'){
  mkdirSync(join(cwd,'release-input/receipts'),{recursive:true});for(const name of ['final.tgz','final.json','analysis.json'])writeFileSync(join(cwd,'release-input',name),readFileSync(join(input,name)));
  writeFileSync(join(cwd,'release-input/recovery.json'),JSON.stringify({source_run_id:'12',artifact_id:'34',source_attempt:1}));writeFileSync(join(cwd,'release-input/receipts/github-release.json'),JSON.stringify({status:'completed',candidate_sha:metadata.candidate_sha,version:metadata.version,sha256:metadata.sha256,observed_at:'2026-11-08T00:00:00Z',remote_id:'77'}));
 }
 if(mode==='stale-github-read-error'||mode==='stale-source-read-error'){
  for(const target of ['npm','github-packages'])writeFileSync(join(cwd,`release-input/receipts/${target}.json`),JSON.stringify({...metadata,status:'completed',observed_at:'2026-11-08T00:00:00Z',latest_version:'9.0.0',channel_observed_at:'2026-11-08T00:00:00Z',remote_id:metadata.name+'@'+metadata.version}));
  writeFileSync(join(cwd,'release-input/receipts/future-target.json'),'{"status":"completed"}');
 }
 const result=spawnSync(process.execPath,[resolve('scripts/release-recover.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,STATE:cwd,REMOTE_MODE:mode,RELEASE_ENABLED:'true',GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:'b'.repeat(40),SOURCE_RUN_ID:'12',ARTIFACT_ID:'34',GITHUB_RUN_ID:'56',RECOVERY_INTENT_ARTIFACT_ID:'78'},encoding:'utf8'});
 return {cwd,result,original};
}
