import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare} from '../scripts/release-payload.mjs';
import {releaseEnv} from './helpers/release-env.mjs';
const notes='## 2.0.0 (2026-11-08)\n\n### BREAKING CHANGES\n\nKeep the complete original notes.\n';
function fixture(analysis){
 const cwd=mkdtempSync(join(tmpdir(),'npm-prepare-identity-')),root=join(cwd,'release-input/unpacked/package');mkdirSync(root,{recursive:true});
 const manifest=JSON.stringify({name:'@scope/public-fixture',version:'1.0.0'});writeFileSync(join(root,'package.json'),manifest);writeFileSync(join(root,'executable.js'),'original executable');
 if(analysis!==undefined)writeFileSync(join(cwd,'release-input/analysis.json'),typeof analysis==='string'?analysis:JSON.stringify(analysis));
 return {cwd,root,manifest,context:{cwd,env:releaseEnv(cwd),nextRelease:{version:'2.0.0',gitTag:'v2.0.0',notes}}};
}
const valid={candidate_sha:'a'.repeat(40),version:'2.0.0',tag:'v2.0.0',notes,baseline_tag:'v1.0.0'};
async function rejectedBeforeMutation(analysis,pattern){
 const {cwd,root,manifest,context}=fixture(analysis);await assert.rejects(prepare({},context),pattern);
 assert.equal(readFileSync(join(root,'package.json'),'utf8'),manifest);assert.equal(readFileSync(join(root,'executable.js'),'utf8'),'original executable');assert.equal(existsSync(join(cwd,'release-input/final.tgz')),false);assert.equal(existsSync(join(cwd,'release-input/final.json')),false);
}
test('prepare requires a parseable verified analysis before changing any package bytes',async()=>{
 await rejectedBeforeMutation(undefined,/analysis|ENOENT/i);await rejectedBeforeMutation('{invalid',/JSON|property|position/i);
});
test('prepare rejects changed or missing full notes before mutation, including UTC date rollover',async()=>{
 await rejectedBeforeMutation({...valid,notes:notes.replace('2026-11-08','2026-11-09')},/notes/i);
 const missing={...valid};delete missing.notes;await rejectedBeforeMutation(missing,/notes/i);
});
test('prepare matches exact verified candidate, version and tag before mutation',async()=>{
 for(const mismatch of [{candidate_sha:'b'.repeat(40)},{version:'3.0.0'},{tag:'v3.0.0'}])await rejectedBeforeMutation({...valid,...mismatch},/analysis|identity/i);
});
test('matching verified full notes and identity preserve original baseline and package content',async()=>{
 const {cwd,root,context}=fixture(valid);await prepare({},context);const final=JSON.parse(readFileSync(join(cwd,'release-input/final.json')));
 assert.equal(final.baseline_tag,'v1.0.0');assert.equal(final.tag,'v2.0.0');assert.equal(final.candidate_sha,valid.candidate_sha);assert.equal(readFileSync(join(root,'executable.js'),'utf8'),'original executable');assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/analysis.json'))).notes,notes);
});
