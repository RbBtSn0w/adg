import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { analyzeCommits } from '../scripts/commit-semantics.mjs';
const require = createRequire(import.meta.url);
const workflow = require('yaml').parse(readFileSync('.github/workflows/release.yml', 'utf8'));
const step = (job, id) => workflow.jobs[job].steps.find(s => s.id === id);
test('entry gate executes only scheduled/manual main candidates; authority is dependent and default-off', () => {
  assert.equal(workflow.jobs.verify.if, "vars.RELEASE_ENABLED == 'true'");
  assert.match(workflow.jobs.release.if, /vars.RELEASE_ENABLED/);
  assert.match(workflow.jobs.release.if, /needs.verify.result/);
  assert.match(workflow.jobs.release.if, /needs.verify.outputs.artifact-id/);
  assert.deepEqual(workflow.jobs.release.needs, ['verify']);
  assert.equal(workflow.jobs.verify.permissions.contents, 'read');
  assert.equal(workflow.jobs.verify.permissions['id-token'], undefined);
  assert.equal(workflow.concurrency.group, 'release-main');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [event, ref, allowed] of [['schedule','refs/heads/main',true], ['workflow_dispatch','refs/heads/main',true], ['push','refs/heads/main',false], ['pull_request','refs/heads/main',false], ['workflow_dispatch','refs/heads/develop',false]]) {
    const result=spawnSync('bash',['-eu','-c',step('verify','gate').run],{env:{...process.env,RELEASE_EVENT:event,RELEASE_REF:ref}});
    assert.equal(result.status===0,allowed);
  }
  assert.equal(workflow.jobs.release.steps.find(s => s.uses?.startsWith('actions/download-artifact@')).with['artifact-ids'], '${{ needs.verify.outputs.artifact-id }}');
});
test('publisher stops on stale, empty, and failed live reads before semantic-release', () => {
 const cwd=mkdtempSync(join(tmpdir(),'release-freshness-'));const bin=join(cwd,'bin');mkdirSync(bin);
 const sha='a'.repeat(40);
 for (const [name,script] of [['git',`echo ${sha}`],['gh','test "$READ_MODE" != failed || exit 23; test "$READ_MODE" != empty || exit 0; if test "$READ_MODE" = stale; then echo stale; else echo '+sha+'; fi'],['npx','touch "$MARKER"']]) writeFileSync(join(bin,name),'#!/bin/sh\n'+script+'\n',{mode:0o755});
 for (const mode of ['failed','empty','stale','current']) {
  const marker=join(cwd,mode);const result=spawnSync('bash',['-eu','-o','pipefail','-c',step('release','publish').run],{cwd,env:{...process.env,PATH:bin+':'+process.env.PATH,CANDIDATE_SHA:sha,READ_MODE:mode,RELEASE_BOT_APP_ID:'1',MARKER:marker,GITHUB_REPOSITORY:'owner/repo',GITHUB_OUTPUT:join(cwd,'output')}});
  assert.equal(result.status===0,mode==='current',result.stderr?.toString());assert.equal(existsSync(marker),mode==='current');
 }
});
test('strict lint checks actual range including skipped malformed commits and analyzer understands breaking forms', async () => {
 const cwd=mkdtempSync(join(tmpdir(),'release-history-'));const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('commit','--allow-empty','-m','chore: baseline');const baseline=git('rev-parse','HEAD');
 git('commit','--allow-empty','-m','feat!: changed contract');
 const context={cwd,lastRelease:{gitHead:baseline},env:{...process.env,RELEASE_TOOLS:resolve('.')}};
 await analyzeCommits({},context);
 git('commit','--allow-empty','-m','malformed [skip release]');await assert.rejects(analyzeCommits({},context),/Invalid Conventional Commit/);
 const {analyzeCommits:analyze}=await import('@semantic-release/commit-analyzer');
 const config=JSON.parse(readFileSync('.releaserc.json','utf8'));const options=config.plugins.find(p=>Array.isArray(p)&&p[0]==='@semantic-release/commit-analyzer')[1];
 for (const [message,expected] of [['fix: repair','patch'],['feat: capability','minor'],['feat!: changed contract','major'],['fix: changed contract\n\nBREAKING CHANGE: changed API','major'],['chore: maintenance',null]]) assert.equal(await analyze(options,{cwd:resolve('.'),commits:[{message,hash:'a'.repeat(40)}],logger:{log(){}}}),expected);
});

test('artifact restore rejects wrong candidate and changed bytes', () => {
 for (const mode of ['valid','wrong-sha','tampered']) {
  const cwd=mkdtempSync(join(tmpdir(),'release-artifact-'));const input=join(cwd,'release-input');mkdirSync(input);const bin=join(cwd,'bin');mkdirSync(bin);
  mkdirSync(join(cwd,'package'));writeFileSync(join(cwd,'package/package.json'),'{}');execFileSync('tar',['-czf',join(input,'package.tgz'),'-C',cwd,'package']);
  const checksum=execFileSync('shasum',['-a','256','package.tgz'],{cwd:input});writeFileSync(join(input,'package.tgz.sha256'),checksum);writeFileSync(join(input,'candidate.sha'),'a'.repeat(40)+'\n');
  if(mode==='tampered')writeFileSync(join(input,'package.tgz'),'changed');writeFileSync(join(bin,'npx'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const result=spawnSync('bash',['-eu','-c',step('release','restore').run],{cwd,env:{...process.env,PATH:bin+':'+process.env.PATH,CANDIDATE_SHA:(mode==='wrong-sha'?'b':'a').repeat(40)}});assert.equal(result.status===0,mode==='valid');
 }
});
