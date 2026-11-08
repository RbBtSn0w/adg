import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare,publish} from '../scripts/release-payload.mjs';
import {releaseEnv,releaseDecision} from './helpers/release-env.mjs';
async function fixture(mode){
 const cwd=mkdtempSync(join(tmpdir(),'normal-known-newer-')),root=join(cwd,'release-input/unpacked/package');mkdirSync(root,{recursive:true});writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'}));
 const env=releaseEnv(cwd),nextRelease=releaseDecision(cwd,'2.0.0');await prepare({}, {cwd,env,nextRelease});const original=readFileSync(join(cwd,'release-input/final.tgz'));
 const latest=mode==='newer'||mode==='existing'?'9.0.0':mode==='same'?'2.0.0':'1.0.0';writeFileSync(join(cwd,'tags.json'),JSON.stringify({npm:mode==='missing'||mode==='package-missing'?null:latest,github:mode==='mirror-newer'?'9.0.0':mode==='missing'||mode==='package-missing'?null:latest}));
 const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),state=process.env.STATE,mode=process.env.MODE,metadata=JSON.parse(fs.readFileSync(path.join(state,'release-input/final.json'))),target=args.at(-1).includes('github')?'github':'npm',marker=path.join(state,'published-'+target+'.tgz'),tagsFile=path.join(state,'tags.json'),tags=JSON.parse(fs.readFileSync(tagsFile));
fs.appendFileSync(path.join(state,'calls.jsonl'),JSON.stringify({target,args})+'\\n');
if(args[0]==='view'&&args[2]==='dist-tags'){
 if(mode==='read-error'){console.error('channel unavailable');process.exit(22);}if(mode==='malformed'){console.log('{invalid');process.exit(0);}if(mode==='invalid-latest'){console.log(JSON.stringify({latest:'next'}));process.exit(0);}if(mode==='package-missing'&&!fs.existsSync(marker)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}
 console.log(JSON.stringify(tags[target]===null?{}:{latest:tags[target]}));
}else if(args[0]==='view'){
 if(mode!=='existing'&&!fs.existsSync(marker)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify(metadata.integrity));
}else if(args[0]==='publish'){
 if(args[args.indexOf('--tag')+1]!=='latest'||!args.includes('--ignore-scripts'))process.exit(97);fs.copyFileSync(args[1],marker);tags[target]=metadata.version;fs.writeFileSync(tagsFile,JSON.stringify(tags));
}else process.exit(99);
`,{mode:0o755});
 return {cwd,original,context:{cwd,env:{...env,PATH:bin+':'+env.PATH,STATE:cwd,MODE:mode},nextRelease}};
}
test('normal missing-version publisher refuses a known newer latest before issuing --tag latest',async()=>{
 const {cwd,context}=await fixture('newer');await assert.rejects(publish({},context),/newer|higher|latest/i);assert.equal(existsSync(join(cwd,'published-npm.tgz')),false);assert.equal(existsSync(join(cwd,'published-github.tgz')),false);assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tags.json'))),{npm:'9.0.0',github:'9.0.0'});
});
test('normal prewrite channel read failures and malformed observations fail closed without publication',async()=>{
 for(const mode of ['read-error','malformed','invalid-latest']){const {cwd,context}=await fixture(mode);await assert.rejects(publish({},context),/latest|channel|tag|JSON|unverifiable/i);assert.equal(existsSync(join(cwd,'published-npm.tgz')),false,mode);}
});
test('normal older, same or absent latest keeps automatic publication of the original verified bytes',async()=>{
 for(const mode of ['older','same','missing','package-missing']){
  const {cwd,context,original}=await fixture(mode);await publish({},context);for(const target of ['npm','github'])assert.deepEqual(readFileSync(join(cwd,`published-${target}.tgz`)),original);assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tags.json'))),{npm:'2.0.0',github:'2.0.0'});
 }
});
test('known-newer prewrite check is applied independently before each registry write',async()=>{
 const {cwd,context,original}=await fixture('mirror-newer');await assert.rejects(publish({},context),/newer|higher|latest/i);assert.deepEqual(readFileSync(join(cwd,'published-npm.tgz')),original);assert.equal(existsSync(join(cwd,'published-github.tgz')),false);assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tags.json'))),{npm:'2.0.0',github:'9.0.0'});assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json'))).status,'completed');
});
test('an already matching version remains read-only and can observe a newer latest',async()=>{
 const {cwd,context}=await fixture('existing');await publish({},context);assert.equal(existsSync(join(cwd,'published-npm.tgz')),false);assert.deepEqual(JSON.parse(readFileSync(join(cwd,'tags.json'))),{npm:'9.0.0',github:'9.0.0'});const calls=readFileSync(join(cwd,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(call=>call.args[0]==='view'&&call.args[2]==='dist-tags').length,2);
});
