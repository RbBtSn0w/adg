import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
test('Homebrew receipt requires remote main formula bytes to match the sealed release',()=>{
 for(const matches of [false,true]){
 const cwd=mkdtempSync(join(tmpdir(),'homebrew-readback-'));for(const dir of ['bin','release-input/receipts','homebrew-tap/Formula'])mkdirSync(join(cwd,dir),{recursive:true});
 const sha='b'.repeat(64),formula=`version "2.0.0"\nsha256 "${sha}"\n`;
 writeFileSync(join(cwd,'release-input/final.json'),JSON.stringify({candidate_sha:'a'.repeat(40),version:'2.0.0',sha256:sha}));writeFileSync(join(cwd,'homebrew-tap/Formula/adg.rb'),formula);
 writeFileSync(join(cwd,'bin/git'),`#!/usr/bin/env node
const args=process.argv.slice(2);if(args[2]==='fetch')process.exit(0);if(args[2]==='rev-parse')console.log('c'.repeat(40));else if(args[2]==='show')console.log(${JSON.stringify(matches?formula:'version "1.0.0"')});else process.exit(99);
`,{mode:0o755});
 const run=spawnSync(process.execPath,[resolve('scripts/release-homebrew-receipt.mjs')],{cwd,env:{...process.env,PATH:join(cwd,'bin')+':'+process.env.PATH},encoding:'utf8'});
 assert.equal(run.status===0,matches,run.stderr);assert.equal(existsSync(join(cwd,'release-input/receipts/homebrew.json')),matches);
 if(matches){const receipt=JSON.parse(readFileSync(join(cwd,'release-input/receipts/homebrew.json')));assert.equal(receipt.remote_id,'c'.repeat(40));assert.equal(receipt.source_sha256,sha);assert.equal(receipt.status,'completed');}
 }
});
