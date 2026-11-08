import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepare,publish} from '../scripts/release-payload.mjs';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'npm-tag-boundary-')),cwd=join(root,'candidate'),origin=join(root,'origin.git');mkdirSync(cwd);
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','core.hooksPath','/dev/null');
 writeFileSync(join(cwd,'README.md'),'Original candidate');git('add','README.md');git('-c','commit.gpgsign=false','commit','-m','feat: original verified candidate');const candidate=git('rev-parse','HEAD');git('clone','--bare',cwd,origin);git('remote','add','origin',origin);
 const pkg=join(cwd,'release-input/unpacked/package');mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0',scripts:{build:'exit 99',prepack:'exit 99'}}));writeFileSync(join(pkg,'executable.js'),'Original verified executable');
 const nextRelease={version:'2.0.0',gitTag:'v2.0.0',gitHead:candidate,notes:'Original complete release notes\n'};writeFileSync(join(cwd,'release-input/analysis.json'),JSON.stringify({candidate_sha:candidate,version:nextRelease.version,tag:nextRelease.gitTag,notes:nextRelease.notes,baseline_tag:'v1.0.0'}));
 const bin=join(root,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'gh'),'#!/bin/sh\nprintf "read\\n" >> "$STATE/main-reads"\ngit --git-dir "$ORIGIN_GIT" rev-parse refs/heads/main\n',{mode:0o755});
 writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto'),args=process.argv.slice(2),state=process.env.STATE,metadata=JSON.parse(fs.readFileSync(path.join(state,'candidate/release-input/final.json'))),target=args.at(-1).includes('github')?'github':'npm',archive=path.join(state,'published-'+target+'.tgz');
if(args[0]==='publish'){if(!args.includes('--ignore-scripts'))process.exit(97);fs.copyFileSync(args[1],archive);}
else if(args[0]==='view'&&args[2]==='dist-tags')console.log(JSON.stringify({latest:metadata.version}));
else if(args[0]==='view'){if(!fs.existsSync(archive)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify('sha512-'+crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64')));}
else process.exit(99);
`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,STATE:root,ORIGIN_GIT:origin,RELEASE_ENABLED:'true',CANDIDATE_SHA:candidate,GITHUB_REPOSITORY:'owner/public-fixture',GITHUB_RUN_ID:'12',GITHUB_RUN_ATTEMPT:'1'};
 const advance=()=>{const tree=git('rev-parse','HEAD^{tree}'),head=execFileSync('git',['commit-tree',tree,'-p',candidate],{cwd,input:'feat: a later main candidate\n',encoding:'utf8'}).trim();git('push','--quiet','origin',`${head}:refs/heads/main`);return head;};
 return {root,cwd,git,env,nextRelease,candidate,advance,context:{cwd,env,nextRelease}};
}
test('production prepare then real tag then main advancement publishes only the original sealed bytes',async()=>{
 const f=fixture();await prepare({},f.context);const archive=readFileSync(join(f.cwd,'release-input/final.tgz'));f.git('tag',f.nextRelease.gitTag);const later=f.advance();assert.notEqual(later,f.candidate);
 await publish({},f.context);
 for(const target of ['npm','github'])assert.deepEqual(readFileSync(join(f.root,`published-${target}.tgz`)),archive);
 assert.equal(f.git('rev-parse',`${f.nextRelease.gitTag}^{commit}`),f.candidate);assert.equal(f.git('rev-parse','HEAD'),f.candidate);assert.equal(readFileSync(join(f.root,'main-reads'),'utf8').trim().split('\n').length,1);assert.equal(JSON.parse(readFileSync(join(f.cwd,'release-input/final.json'))).candidate_sha,f.candidate);
});
test('main advancement before prepare still refuses publication identity before any tag or registry writes',async()=>{
 const f=fixture();f.advance();await assert.rejects(prepare({},f.context),/Main changed/);assert.equal(f.git('tag'), '');assert.equal(existsSync(join(f.root,'published-npm.tgz')),false);assert.equal(f.git('rev-parse','HEAD'),f.candidate);
});
test('post-tag publisher remains bound to the selected tag, notes and engine candidate',async()=>{
 for(const altered of [{gitTag:'v9.0.0'},{notes:'Changed notes'},{gitHead:'b'.repeat(40)}]){
  const f=fixture();await prepare({},f.context);f.git('tag',f.nextRelease.gitTag);await assert.rejects(publish({}, {...f.context,nextRelease:{...f.nextRelease,...altered}}),/identity|analysis|mismatch/i);assert.equal(existsSync(join(f.root,'published-npm.tgz')),false);
 }
});
