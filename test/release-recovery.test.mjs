import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePayload, selectRecoveryEntries } from '../scripts/release-recover.mjs';
import { verifyRecoverySource } from '../.github/release-train/recovery-source.mjs';
import { createResult } from '../.github/release-train/release-result.mjs';
test('recovery accepts original identity and rejects version, candidate, tag and digest drift', () => {
 const cwd=mkdtempSync(join(tmpdir(),'release-sealed-'));mkdirSync(join(cwd,'package'));
 writeFileSync(join(cwd,'package/package.json'),JSON.stringify({name:'@scope/public-fixture',version:'2.0.0'}));
 const archive=join(cwd,'final.tgz');execFileSync('tar',['-czf',archive,'-C',cwd,'package']);
 const bytes=execFileSync('cat',[archive]);
 const metadata={name:'@scope/public-fixture',version:'2.0.0',tag:'v2.0.0',candidate_sha:'a'.repeat(40),repository:'owner/repo',source_run_id:'12',sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')};
 const analysis={version:'2.0.0',tag:'v2.0.0',candidate_sha:'a'.repeat(40)};
 assert.equal(validatePayload(metadata,analysis,archive),metadata);
 for(const field of ['version','tag','candidate_sha','sha256','integrity']) assert.throws(()=>validatePayload({...metadata,[field]:'different'},analysis,archive));
});
test('recovery verifies immutable repository/run/workflow/artifact association',()=>{
 const run={id:12,repository:{full_name:'owner/repo'},path:'.github/workflows/release.yml',head_branch:'main',event:'schedule',status:'completed',head_sha:'a'.repeat(40)};
 const artifact={id:34,expired:false,workflow_run:{id:12,head_sha:run.head_sha}};
 const input={run,artifact,repository:'owner/repo',sourceRunId:'12',artifactId:'34'};
 assert.equal(verifyRecoverySource(input).candidate_sha,run.head_sha);
 for(const bad of [{...run,path:'.github/workflows/ci.yml'},{...run,repository:{full_name:'other/repo'}},{...run,head_branch:'feature'}])assert.throws(()=>verifyRecoverySource({...input,run:bad}));
 assert.throws(()=>verifyRecoverySource({...input,artifact:{...artifact,expired:true}}));
 assert.throws(()=>verifyRecoverySource({...input,artifact:{...artifact,workflow_run:{id:99,head_sha:run.head_sha}}}));
});
test('summary distinguishes disabled, no-release and partial targets',()=>{
 const base={candidate_sha:'a'.repeat(40),enabled:true,intended_targets:['npm','mirror'],analysis:'success',verification:'passed',version:'2.0.0',targets:{npm:{status:'completed',candidate_sha:'a'.repeat(40),version:'2.0.0',observed_at:'2026-11-08T00:00:00Z',url:'https://www.npmjs.com/package/example/v/2.0.0'},mirror:{status:'failed'}}};
 assert.equal(createResult(base).publication,'partial');assert.equal(createResult({...base,enabled:false}).publication,'disabled');
 assert.equal(createResult({...base,version:null,targets:{}}).publication,'no-release');
});

test('recovery reads only controlled ZIP members and rejects traversal, duplicate and ambiguous members', () => {
 const entries = ['final.json','final.tgz','analysis.json','receipts/npm.json'];
 assert.deepEqual(selectRecoveryEntries(entries), {'final.json':'final.json','final.tgz':'final.tgz','analysis.json':'analysis.json'});
 for (const extra of ['../escape','/absolute','directory\\escape','final.json','release-input/final.json']) assert.throws(()=>selectRecoveryEntries([...entries,extra]));
 assert.throws(()=>selectRecoveryEntries(['final.json','release-input/final.tgz','analysis.json']));
 // Other ZIP entries, including symlinks, are never extracted or followed.
 assert.equal(selectRecoveryEntries([...entries,'untrusted-symlink'])['final.tgz'],'final.tgz');
});
