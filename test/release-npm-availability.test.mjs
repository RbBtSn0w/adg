import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare,publish} from '../scripts/release-payload.mjs';
import {releaseEnv,releaseDecision} from './helpers/release-env.mjs';

function budget(limit=20){
 let ticks=0;
 const remaining=()=>Math.max(0,(limit-ticks)*1000);
 const assertRemaining=()=>{if(!remaining())throw Error('npm observation deadline exceeded');return remaining();};
 return {remaining,assertRemaining,async wait(read){for(;;){const value=await read(assertRemaining());assertRemaining();if(value!==null)return value;ticks++;}},get ticks(){return ticks;}};
}
async function fixture(mode){
 const cwd=mkdtempSync(join(tmpdir(),'npm-availability-')),root=join(cwd,'release-input/unpacked/package');
 mkdirSync(root,{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'}));
 const env=releaseEnv(cwd),nextRelease=releaseDecision(cwd,'2.0.0');await prepare({}, {cwd,env,nextRelease});
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),state=process.env.STATE,mode=process.env.MODE,target=args.includes('https://npm.pkg.github.com')?'github-packages':'npm',meta=JSON.parse(fs.readFileSync(path.join(state,'release-input/final.json'))),marker=path.join(state,target),receipt=path.join(state,'release-input/receipts',target+'.json');
fs.appendFileSync(path.join(state,'calls.jsonl'),JSON.stringify({target,args})+'\\n');
const missing=()=>{console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);};
if(args[0]==='publish'){
 if(!fs.existsSync(receipt))process.exit(92);
 const pending=JSON.parse(fs.readFileSync(receipt));if(pending.status!=='unknown'||pending.candidate_sha!==meta.candidate_sha||pending.integrity!==meta.integrity||pending.publication_accepted===true)process.exit(93);
 if(mode==='rejected')process.exit(23);
 fs.writeFileSync(marker,JSON.stringify({bytes:0,channel:0}));process.exit(0);
}
if(!fs.existsSync(marker)) {if(args[2]==='dist-tags'){console.log(JSON.stringify({latest:'1.0.0'}));process.exit(0);}missing();}
const receiptValue=JSON.parse(fs.readFileSync(receipt));if(receiptValue.publication_accepted!==true||!receiptValue.accepted_at)process.exit(94);
const counts=JSON.parse(fs.readFileSync(marker));const kind=args[2]==='dist-tags'?'channel':'bytes';counts[kind]++;fs.writeFileSync(marker,JSON.stringify(counts));
if(kind==='channel'){console.log(JSON.stringify(counts.channel<=2&&mode==='lag'?{}:{latest:meta.version}));process.exit(0);}
if(mode==='auth'){console.log(JSON.stringify({error:{code:'E401'}}));process.exit(1);}
if(mode==='malformed'){console.log('{bad');process.exit(0);}
if(mode==='mismatch'){console.log(JSON.stringify('sha512-wrong'));process.exit(0);}
if(mode==='timeout'||(mode==='lag'&&counts.bytes<=4))missing();
console.log(JSON.stringify(meta.integrity));
`,{mode:0o755});
 return {cwd,context:{cwd,env:{...env,PATH:bin+':'+env.PATH,STATE:cwd,MODE:mode},nextRelease}};
}
function calls(cwd){return readFileSync(join(cwd,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}
function receipt(cwd,target='npm'){return JSON.parse(readFileSync(join(cwd,'release-input/receipts',target+'.json')));}

test('accepted publications wait through byte and channel lag without republishing',async()=>{
 const {cwd,context}=await fixture('lag'),observationBudget=budget();await publish({observationBudget},context);
 assert.equal(calls(cwd).filter(call=>call.args[0]==='publish').length,2);
 assert.equal(observationBudget.ticks,12);
 for(const target of ['npm','github-packages']){const value=receipt(cwd,target);assert.equal(value.status,'completed');assert.equal(value.publication_accepted,true);assert.ok(value.accepted_at);assert.ok(value.request_started_at);assert.equal(value.bytes_verified,true);}
});
test('a shared deadline retains accepted identity and prevents later registry publication',async()=>{
 const {cwd,context}=await fixture('lag');await assert.rejects(publish({observationBudget:budget(6)},context),/deadline/);
 assert.equal(calls(cwd).filter(call=>call.args[0]==='publish').length,1);
 assert.equal(receipt(cwd).status,'unknown');assert.equal(receipt(cwd).publication_accepted,true);assert.ok(receipt(cwd).accepted_at);assert.equal(existsSync(join(cwd,'release-input/released-version')),false);
});
test('publish failure retains the original unknown receipt without claiming acceptance',async()=>{
 const {cwd,context}=await fixture('rejected');await assert.rejects(publish({observationBudget:budget()},context));
 const value=receipt(cwd);assert.equal(value.status,'unknown');assert.equal(value.version,'2.0.0');assert.equal(value.candidate_sha,'a'.repeat(40));assert.notEqual(value.publication_accepted,true);assert.equal(value.accepted_at,undefined);
});
for(const mode of ['auth','malformed','mismatch'])test(mode+' after publish fails immediately and retains accepted evidence',async()=>{
 const {cwd,context}=await fixture(mode),observationBudget=budget();await assert.rejects(publish({observationBudget},context));
 assert.equal(observationBudget.ticks,0);assert.equal(calls(cwd).filter(call=>call.args[0]==='publish').length,1);
 assert.equal(JSON.parse(readFileSync(join(cwd,'npm'))).bytes,1);assert.equal(receipt(cwd).publication_accepted,true);
});

test('target-only publication leaves the other target untouched and emits no global marker',async()=>{
 const {cwd,context}=await fixture('lag');await publish({target:'npm',observationBudget:budget()},context);
 assert.equal(calls(cwd).filter(call=>call.target==='github-packages').length,0);assert.equal(receipt(cwd,'github-packages').status,'not-run');assert.equal(existsSync(join(cwd,'release-input/released-version')),false);
});
test('lookup failure preserves original not-run request evidence',async()=>{
 const {cwd,context}=await fixture('lag');const meta=JSON.parse(readFileSync(join(cwd,'release-input/final.json')));mkdirSync(join(cwd,'release-input/receipts'));writeFileSync(join(cwd,'release-input/receipts/npm.json'),JSON.stringify({...meta,status:'not-run'}));writeFileSync(join(cwd,'bin/npm'),'#!/bin/sh\nexit 42\n',{mode:0o755});
 await assert.rejects(publish({recovery:true,target:'npm',preflight:true,observationBudget:budget()},context));assert.equal(receipt(cwd).status,'not-run');
});

test('preflight read failure invalidates a prior completed observation while preserving request facts',async()=>{
 const {cwd,context}=await fixture('lag');const meta=JSON.parse(readFileSync(join(cwd,'release-input/final.json')));mkdirSync(join(cwd,'release-input/receipts'));writeFileSync(join(cwd,'release-input/receipts/npm.json'),JSON.stringify({...meta,status:'completed',latest_version:'2.0.0',bytes_verified:true,request_started_at:'2026-11-09T01:00:00Z',publication_accepted:true,accepted_at:'2026-11-09T01:00:01Z'}));writeFileSync(join(cwd,'bin/npm'),'#!/bin/sh\nexit 42\n',{mode:0o755});
 await assert.rejects(publish({recovery:true,target:'npm',preflight:true,observationBudget:budget()},context));const value=receipt(cwd);assert.equal(value.status,'unknown');assert.equal(value.bytes_verified,false);assert.equal(value.latest_version,undefined);assert.equal(value.request_started_at,'2026-11-09T01:00:00Z');assert.equal(value.publication_accepted,true);assert.equal(existsSync(join(cwd,'npm')),false);
});
