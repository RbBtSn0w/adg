import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
test('recovery completes missing targets from original bytes after main advances without rebuilding or retagging',()=>{
 const {cwd,result,original}=runRecovery();
 assert.equal(result.status,0,result.stderr);
 for(const file of ['npm.tgz','mirror.tgz','uploaded-final.tgz'])assert.deepEqual(readFileSync(join(cwd,file)),original);
 assert.equal(existsSync(join(cwd,'npm.tgz.tag')),false);
 assert.equal(readFileSync(join(cwd,'draft-published'),'utf8'),'true');
 assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/recovery.json'))).source_run_id,'12');
 assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/recovery.json'))).source_attempt,1);
});
test('conflicting notes or assets and unknown GitHub readback block recovery before registry writes',()=>{
 for(const mode of ['notes-conflict','asset-conflict','read-error']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0,mode);
  assert.equal(existsSync(join(cwd,'npm.tgz')),false,`${mode} must not write npm`);
  assert.equal(existsSync(join(cwd,'mirror.tgz')),false,`${mode} must not write GitHub Packages`);
 }
});
test('proven missing release, missing assets and matching draft remain repairable',()=>{
 for(const mode of ['missing-release','missing-assets','matching-draft']){
  const {cwd,result}=runRecovery(mode);assert.equal(result.status,0,`${mode}: ${result.stderr}`);
  assert.equal(existsSync(join(cwd,'npm.tgz')),true);
 }
});

test('actual recovery rejects invalid artifact role suffixes and attempts before external writes',()=>{
 for(const mode of ['role-extra','role-zero','role-future','role-unsafe']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0,mode);
  for(const file of ['npm.tgz','mirror.tgz','draft-published','release-created','recovery.zip'])assert.equal(existsSync(join(cwd,file)),false,`${mode}: ${file}`);
 }
});
