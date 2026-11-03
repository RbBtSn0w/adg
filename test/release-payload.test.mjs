import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, publish } from '../scripts/release-payload.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('prepare injects only manifest version and preserves packed executable bytes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-payload-'));
  const pkg = join(cwd, 'release-input/unpacked/package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({name:'@rbbtsn0w/example', version:'1.0.0', scripts:{prepack:'exit 99'}, files:['dist']}));
  mkdirSync(join(pkg,'dist')); writeFileSync(join(pkg,'dist/cli.js'),'console.log("packed");');
  await prepare({}, {cwd, nextRelease:{version:'2.0.0'}});
  assert.equal(readFileSync(join(pkg,'dist/cli.js'),'utf8'),'console.log("packed");');
  const manifest=JSON.parse(execFileSync('tar',['-xOf',join(cwd,'release-input/final.tgz'),'package/package.json'],{encoding:'utf8'}));
  assert.equal(manifest.version,'2.0.0');
  assert.equal(manifest.scripts.prepack,'exit 99');
});

test('registry identities are verified, missing targets receive the identical archive, and failures remain visible', async () => {
 for (const mode of ['existing','missing','mismatch','lookup-failed','mirror-failed']) {
  const cwd=mkdtempSync(join(tmpdir(),'release-registry-'));const input=join(cwd,'release-input');const root=join(input,'unpacked/package');mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@scope/fixture',version:'1.0.0'}));await prepare({}, {cwd,nextRelease:{version:'1.1.0'}});
  const bin=join(cwd,'bin');mkdirSync(bin);writeFileSync(join(bin,'npm'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);const target=args.at(-1).includes('github')?'github':'npm';const marker=path.join(process.env.STATE,target);const metadata=JSON.parse(fs.readFileSync(path.join(process.env.STATE,'release-input/final.json')));
if(args[0]==='view') {if(process.env.MODE==='lookup-failed'){console.error('network unavailable');process.exit(1);}if(process.env.MODE==='mismatch'){console.log(JSON.stringify('sha512-wrong'));process.exit(0);}if((process.env.MODE==='missing'||process.env.MODE==='mirror-failed')&&!fs.existsSync(marker)){console.log(JSON.stringify({error:{code:'E404'}}));process.exit(1);}console.log(JSON.stringify(metadata.integrity));}
else {if(process.env.MODE==='mirror-failed'&&target==='github'){console.error('mirror denied');process.exit(23);}fs.writeFileSync(marker,args[1]);}
`,{mode:0o755});
  const context={cwd,env:{...process.env,PATH:bin+':'+process.env.PATH,STATE:cwd,MODE:mode,CANDIDATE_SHA:'a'.repeat(40)},nextRelease:{version:'1.1.0'}};
  if(['mismatch','lookup-failed','mirror-failed'].includes(mode)) await assert.rejects(publish({},context));else await publish({},context);
  if(mode==='missing'){assert.equal(readFileSync(join(cwd,'npm'),'utf8'),join(input,'final.tgz'));assert.equal(readFileSync(join(cwd,'github'),'utf8'),join(input,'final.tgz'));}
  if(mode==='mirror-failed'){assert.ok(readFileSync(join(input,'receipts/npm.json'),'utf8'));assert.equal(existsSync(join(input,'receipts/github-packages.json')),false);}
 }
});
