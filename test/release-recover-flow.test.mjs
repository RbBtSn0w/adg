import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
test('recovery completes missing targets from original bytes after main advances without rebuilding or retagging', () => {
 const cwd=mkdtempSync(join(tmpdir(),'release-recovery-flow-'));
 const input=join(cwd,'sealed');mkdirSync(input);mkdirSync(join(cwd,'package'));mkdirSync(join(cwd,'bin'));
 writeFileSync(join(cwd,'package/package.json'),JSON.stringify({name:'@scope/public-fixture',version:'2.0.0',scripts:{build:'exit 99'}}));
 execFileSync('tar',['-czf',join(input,'final.tgz'),'-C',cwd,'package']);
 const original=readFileSync(join(input,'final.tgz'));const digest=algorithm=>createHash(algorithm).update(original).digest(algorithm==='sha512'?'base64':'hex');
 const metadata={name:'@scope/public-fixture',version:'2.0.0',tag:'v2.0.0',candidate_sha:'a'.repeat(40),repository:'owner/repo',source_run_id:'12',operation:'release',sha256:digest('sha256'),integrity:'sha512-'+digest('sha512')};
 writeFileSync(join(input,'final.json'),JSON.stringify(metadata));writeFileSync(join(input,'analysis.json'),JSON.stringify({...metadata,notes:'Original release notes'}));
 execFileSync('zip',['-q',join(cwd,'original.zip'),'final.tgz','final.json','analysis.json'],{cwd:input});
 const zipDigest='sha256:'+createHash('sha256').update(readFileSync(join(cwd,'original.zip'))).digest('hex');
 writeFileSync(join(cwd,'artifact.json'),JSON.stringify({id:34,expired:false,name:'release-receipts-'+metadata.candidate_sha+'-1',digest:zipDigest,workflow_run:{id:12,head_sha:metadata.candidate_sha}}));
 writeFileSync(join(cwd,'run.json'),JSON.stringify({id:12,repository:{full_name:'owner/repo'},path:'.github/workflows/release.yml',head_branch:'main',head_sha:metadata.candidate_sha,event:'schedule',status:'completed'}));
 writeFileSync(join(cwd,'bin/gh'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2),state=process.env.STATE;
const read=name=>fs.readFileSync(path.join(state,name));
if(args[0]==='api') {
 const url=args[1];
 if(url.endsWith('/runs/12'))process.stdout.write(read('run.json'));
 else if(url.endsWith('/artifacts/34'))process.stdout.write(read('artifact.json'));
 else if(url.endsWith('/artifacts/34/zip'))process.stdout.write(read('original.zip'));
 else if(url.includes('/git/ref/tags/'))console.log(JSON.stringify({object:{type:'commit',sha:'a'.repeat(40)}}));
 else if(url.endsWith('/releases'))console.log(JSON.stringify([[{tag_name:'v2.0.0',body:'Original release notes',prerelease:false,draft:!fs.existsSync(path.join(state,'draft-published')),assets:['final.tgz','final.json'].filter(name=>fs.existsSync(path.join(state,'uploaded-'+name))).map(name=>({name,digest:'sha256:'+require('crypto').createHash('sha256').update(read('uploaded-'+name)).digest('hex')})),html_url:'https://github.com/owner/repo/releases/tag/v2.0.0'}]]));
 else {console.error('unexpected API '+url);process.exit(99);}
} else if(args[0]==='release'&&args[1]==='upload'){fs.copyFileSync(args[3],path.join(state,'uploaded-'+path.basename(args[3])));}
else if(args[0]==='release'&&args[1]==='edit'&&args.includes('--draft=false'))fs.writeFileSync(path.join(state,'draft-published'),'true');
else {console.error('unexpected write '+args);process.exit(99);}
`,{mode:0o755});
 writeFileSync(join(cwd,'bin/npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const state=process.env.STATE,marker=path.join(state,args.at(-1).includes('github')?'mirror.tgz':'npm.tgz');const metadata=JSON.parse(fs.readFileSync(path.join(state,'release-input/final.json')));
if(args[0]==='view'&&args[2]==='dist-tags'){const tag='recovery-12';console.log(JSON.stringify({latest:'9.0.0',...(fs.existsSync(marker+'.tag')?{[tag]:'2.0.0'}:{})}));}
else if(args[0]==='view'){if(!fs.existsSync(marker)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify(metadata.integrity));}
else if(args[0]==='publish'){const tag=args[args.indexOf('--tag')+1];if(!tag.startsWith('recovery-')){console.error('recovery must preserve newer latest');process.exit(97);}fs.copyFileSync(args[1],marker);fs.writeFileSync(marker+'.tag',tag);}
else if(args[0]==='dist-tag'&&args[1]==='rm'&&args[3]==='recovery-12'){fs.unlinkSync(marker+'.tag');}
else process.exit(98);
`,{mode:0o755});
 for(const command of ['git','npx'])writeFileSync(join(cwd,'bin',command),'#!/bin/sh\nexit 99\n',{mode:0o755});
 const result=spawnSync(process.execPath,[resolve('scripts/release-recover.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH,STATE:cwd,RELEASE_ENABLED:'true',GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:'b'.repeat(40),SOURCE_RUN_ID:'12',ARTIFACT_ID:'34'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 for(const file of ['npm.tgz','mirror.tgz','uploaded-final.tgz'])assert.deepEqual(readFileSync(join(cwd,file)),original);
 assert.equal(existsSync(join(cwd,'npm.tgz.tag')),false);
 assert.equal(readFileSync(join(cwd,'draft-published'),'utf8'),'true');
 assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/recovery.json'))).source_run_id,'12');
});
