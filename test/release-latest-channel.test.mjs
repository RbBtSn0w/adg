import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare,publish} from '../scripts/release-payload.mjs';
import {releaseEnv,releaseDecision} from './helpers/release-env.mjs';
async function fixture(mode){
 const cwd=mkdtempSync(join(tmpdir(),'npm-channel-readback-')),root=join(cwd,'release-input/unpacked/package');mkdirSync(root,{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'}));
 const env=releaseEnv(cwd),nextRelease=releaseDecision(cwd,'2.0.0');await prepare({}, {cwd,env,nextRelease});
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),mode=process.env.MODE,metadata=JSON.parse(fs.readFileSync(path.join(process.env.STATE,'release-input/final.json')));
if(args[0]!=='view'){fs.writeFileSync(path.join(process.env.STATE,'unexpected-write'),'true');process.exit(99);}
if(args[2]==='dist-tags'){if(mode==='read-error'){console.error('channel unavailable');process.exit(22);}console.log(JSON.stringify(mode==='missing'?{}:{latest:mode==='stale'?'1.0.0':mode==='invalid'?'next':mode==='newer'?'3.0.0':'2.0.0'}));}
else console.log(JSON.stringify(metadata.integrity));
`,{mode:0o755});
 return {cwd,context:{cwd,env:{...env,PATH:bin+':'+env.PATH,STATE:cwd,MODE:mode,RELEASE_ENABLED:'true'},nextRelease}};
}
test('matching registry bytes with stale, absent, malformed or unreadable latest cannot complete receipts',async()=>{
 for(const mode of ['stale','missing','invalid','read-error']){
  const {cwd,context}=await fixture(mode);await assert.rejects(publish({},context),/latest|channel|tag/i);
  const receipt=JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json')));assert.equal(receipt.status,'unknown',mode);assert.equal(receipt.bytes_verified,true);assert.equal(receipt.channel_observed_at,undefined);assert.equal(existsSync(join(cwd,'unexpected-write')),false,mode);
 }
});
test('normal publication records current or newer latest evidence without changing distribution tags',async()=>{
 for(const mode of ['current','newer']){
  const {cwd,context}=await fixture(mode);await publish({},context);
  for(const name of ['npm','github-packages']){const receipt=JSON.parse(readFileSync(join(cwd,`release-input/receipts/${name}.json`)));assert.equal(receipt.latest_version,mode==='newer'?'3.0.0':'2.0.0');assert.ok(Number.isFinite(Date.parse(receipt.channel_observed_at)));}
  assert.equal(existsSync(join(cwd,'unexpected-write')),false);
 }
});
test('direct product publication requires the explicit publication switch before registry access',async()=>{
 const {cwd,context}=await fixture('current');context.env.RELEASE_ENABLED='false';await assert.rejects(publish({},context),/disabled/i);assert.equal(existsSync(join(cwd,'release-input/receipts')),false);assert.equal(existsSync(join(cwd,'unexpected-write')),false);
});

test('channel deferral cannot turn ordinary publication into a successful partial release',async()=>{
 const {cwd,context}=await fixture('stale');await assert.rejects(publish({deferChannelErrors:true},context),/latest|channel/i);assert.equal(existsSync(join(cwd,'release-input/receipts/github-packages.json')),false);assert.equal(existsSync(join(cwd,'release-input/released-version')),false);
});
