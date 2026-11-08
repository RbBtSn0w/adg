import { releaseEnv, releaseDecision } from './helpers/release-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, publish } from '../scripts/release-payload.mjs';
test('post-publish visibility delays retry reads without repeating publication', async () => {
 const cwd=mkdtempSync(join(tmpdir(),'release-visibility-'));const root=join(cwd,'release-input/unpacked/package');mkdirSync(root,{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/fixture',version:'1.0.0'}));await prepare({}, {cwd,env:releaseEnv(cwd),nextRelease: releaseDecision(cwd, '1.1.0')});
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const target=args.at(-1).includes('github')?'github':'npm';const marker=path.join(process.env.STATE,target);const metadata=JSON.parse(fs.readFileSync(path.join(process.env.STATE,'release-input/final.json')));
if(args[0]==='publish'){if(fs.existsSync(marker))process.exit(99);fs.writeFileSync(marker,args[1]);process.exit(0);}
const countFile=marker+'.reads';const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile)):0;fs.writeFileSync(countFile,String(count+1));
if(count<2){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify(metadata.integrity));
`,{mode:0o755});
 await publish({}, {cwd,env:{...releaseEnv(cwd),PATH:bin+':'+releaseEnv(cwd).PATH,STATE:cwd,CANDIDATE_SHA:'a'.repeat(40)},nextRelease: releaseDecision(cwd, '1.1.0')});
 for(const target of ['npm','github']) assert.equal(readFileSync(join(cwd,target+'.reads'),'utf8'),'3');
});
