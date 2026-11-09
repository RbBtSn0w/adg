import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {runRecovery} from './helpers/release-recovery-fixture.mjs';
test('recovery completes missing targets from original bytes after main advances without rebuilding or retagging',()=>{
 const {cwd,result,original}=runRecovery();
 assert.equal(result.status,0,result.stderr);
 for(const file of ['npm.tgz','mirror.tgz','uploaded-final.tgz'])assert.deepEqual(readFileSync(join(cwd,file)),original);
 assert.equal(existsSync(join(cwd,'npm.tgz.tag')),true);assert.equal(existsSync(join(cwd,'channel-mutations.jsonl')),false);
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

test('final GitHub readback rejects notes, channel or release identity changed during reconciliation',()=>{
 for(const mode of ['mutation-notes','mutation-channel','mutation-id']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0,mode);
  assert.equal(existsSync(join(cwd,'release-input/receipts/github-release.json')),false,mode);
 }
});

test('safe recovery may restore missing bytes but never moves or cleans tags for older or absent latest',()=>{
 for(const mode of ['channel-older','channel-missing']){
  const {cwd,result,original}=runRecovery(mode);assert.notEqual(result.status,0,mode);assert.deepEqual(readFileSync(join(cwd,'npm.tgz')),original);assert.equal(existsSync(join(cwd,'npm.tgz.tag')),true);assert.equal(existsSync(join(cwd,'channel-mutations.jsonl')),false);
  const receipt=JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json')));assert.equal(receipt.status,'unknown');assert.equal(receipt.bytes_verified,true);assert.equal(receipt.channel_blocked,true);
 }
});

test('recovering an older matching draft explicitly preserves the GitHub latest designation',()=>{
 const {cwd,result}=runRecovery('matching-draft');assert.equal(result.status,0,result.stderr);const args=JSON.parse(readFileSync(join(cwd,'draft-edit-args.json')));assert.ok(args.includes('--draft=false'));assert.ok(args.includes('--latest=false'));
});

test('safe recovery defers only verified channel failures while completing remaining immutable targets',()=>{
 for(const mode of ['channel-older','channel-missing','channel-npm-only']){
  const {cwd,result,original}=runRecovery(mode);assert.notEqual(result.status,0,mode);assert.match(result.stderr,/latest|channel/i);
  for(const file of ['npm.tgz','mirror.tgz','uploaded-final.tgz'])assert.deepEqual(readFileSync(join(cwd,file)),original,`${mode}: ${file}`);
  const npm=JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json'))),mirror=JSON.parse(readFileSync(join(cwd,'release-input/receipts/github-packages.json'))),github=JSON.parse(readFileSync(join(cwd,'release-input/receipts/github-release.json')));
  assert.equal(npm.status,'unknown');assert.equal(npm.channel_blocked,true);assert.equal(github.status,'completed');assert.equal(mirror.status,mode==='channel-npm-only'?'completed':'unknown');assert.equal(existsSync(join(cwd,'channel-mutations.jsonl')),false);
 }
});
test('recovery still immediately stops on unverified or conflicting registry bytes',()=>{
 for(const mode of ['registry-bytes-conflict','registry-read-error']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0);for(const file of ['npm.tgz','mirror.tgz','uploaded-final.tgz','draft-published'])assert.equal(existsSync(join(cwd,file)),false,`${mode}: ${file}`);
 }
});


test('original request evidence survives artifact inspection and prevents repeated publication',()=>{
 for(const mode of ['accepted-request','uncertain-request']){
  const {cwd,result}=runRecovery(mode);assert.equal(result.status,0,result.stderr);
  const writes=readFileSync(join(cwd,'registry-writes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(writes.length,1);assert.ok(writes[0].includes('https://npm.pkg.github.com'));
  const receipt=JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json')));
  assert.equal(receipt.status,'completed');assert.equal(receipt.request_started_at,'2026-11-09T01:00:00Z');
  assert.equal(receipt.publication_accepted,mode==='accepted-request'?true:undefined);
 }
});
test('missing or foreign original request evidence never authorizes a registry write',()=>{
 for(const mode of ['receipt-missing','receipt-conflict']){
  const {cwd,result}=runRecovery(mode);assert.notEqual(result.status,0,mode);
  assert.equal(existsSync(join(cwd,'registry-writes.jsonl')),false,mode);
 }
});


test('a later recovery cannot reuse the original not-run authorization',()=>{
 const {cwd,result}=runRecovery('prior-recovery-request');assert.equal(result.status,0,result.stderr);
 assert.equal(existsSync(join(cwd,'registry-writes.jsonl')),false);
 for(const target of ['npm','github-packages'])assert.equal(JSON.parse(readFileSync(join(cwd,`release-input/receipts/${target}.json`))).status,'completed');
});

test('phased recovery creates intent only after each successful registry preflight',()=>{
 const {cwd,result}=runRecovery('missing-assets','v2.0.0',true);assert.equal(result.status,0,result.stderr);
 for(const target of ['npm','github-packages']){assert.equal(existsSync(join(cwd,'intent-'+target)),true);const receipt=JSON.parse(readFileSync(join(cwd,`release-input/receipts/${target}.json`)));assert.equal(receipt.status,'completed');assert.ok(receipt.request_started_at);}
 assert.equal(existsSync(join(cwd,'release-input/released-version')),true);
});
test('first registry preflight failure preserves not-run and creates no target intents',()=>{
 const {cwd,result}=runRecovery('registry-read-error','v2.0.0',true);assert.notEqual(result.status,0);
 for(const target of ['npm','github-packages']){assert.equal(existsSync(join(cwd,'intent-'+target)),false);assert.equal(JSON.parse(readFileSync(join(cwd,`release-input/receipts/${target}.json`))).status,'not-run');}
});
test('unverified first request fails before consuming the mirror authorization',()=>{
 const {cwd,result}=runRecovery('accepted-invisible','v2.0.0',true);assert.notEqual(result.status,0);
 assert.equal(existsSync(join(cwd,'intent-npm')),true);assert.equal(existsSync(join(cwd,'intent-github-packages')),false);
 const receipt=JSON.parse(readFileSync(join(cwd,'release-input/receipts/npm.json')));assert.equal(receipt.publication_accepted,true);assert.ok(receipt.request_started_at);
 assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/receipts/github-packages.json'))).status,'not-run');
});
test('phased channel failure defers after byte verification and finalization remains incomplete',()=>{
 const {cwd,result}=runRecovery('channel-npm-only','v2.0.0',true);assert.notEqual(result.status,0);
 assert.equal(existsSync(join(cwd,'intent-github-packages')),true);assert.equal(JSON.parse(readFileSync(join(cwd,'release-input/receipts/github-packages.json'))).status,'completed');assert.equal(existsSync(join(cwd,'release-input/receipts/github-release.json')),true);assert.equal(existsSync(join(cwd,'release-input/released-version')),false);
});

test('repeated phased recovery and legacy global intents create no new registry markers',()=>{
 for(const mode of ['prior-recovery-request','legacy-recovery-intent']){const {cwd,result}=runRecovery(mode,'v2.0.0',true);assert.equal(result.status,0,result.stderr);assert.equal(existsSync(join(cwd,'registry-writes.jsonl')),false);for(const target of ['npm','github-packages'])assert.equal(existsSync(join(cwd,'intent-'+target)),false);}
});

test('visible original bytes recover without legacy request receipts or new intents',()=>{
 const {cwd,result}=runRecovery('visible-legacy-receipts','v2.0.0',true);assert.equal(result.status,0,result.stderr);assert.equal(existsSync(join(cwd,'registry-writes.jsonl')),false);for(const target of ['npm','github-packages'])assert.equal(existsSync(join(cwd,'intent-'+target)),false);
});
test('finalization succeeds after registry deadline expires once targets are confirmed',()=>{
 const {cwd,result}=runRecovery('finalize-expired-budget','v2.0.0',true);assert.equal(result.status,0,result.stderr);assert.equal(existsSync(join(cwd,'release-input/released-version')),true);
});
test('later phases reject a prepared payload belonging to a different dispatch',()=>{
 const {cwd,result}=runRecovery('prepared-dispatch-conflict','v2.0.0',true);assert.notEqual(result.status,0);assert.match(result.stderr,/Prepared recovery differs/);assert.equal(existsSync(join(cwd,'registry-writes.jsonl')),false);for(const target of ['npm','github-packages'])assert.equal(existsSync(join(cwd,'intent-'+target)),false);
});
