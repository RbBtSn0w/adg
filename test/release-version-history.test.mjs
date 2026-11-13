import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';

const payload = pathToFileURL(resolve('scripts/release-payload.mjs')).href;
const engine = pathToFileURL(resolve('node_modules/semantic-release/index.js')).href;
function release(history, status = 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-version-history-'));
  const remote = cwd + '-remote.git';
  const env = {PATH: process.env.PATH, HOME: join(cwd, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
  mkdirSync(env.HOME);
  const git = (...args) => execFileSync('git', args, {cwd, env, encoding: 'utf8'}).trim();
  try {
    git('init', '--quiet', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('commit', '--quiet', '--allow-empty', '-m', 'chore: baseline');
    git('tag', 'v0.11.4');
    git('commit', '--quiet', '--allow-empty', '-m', 'feat!: new runtime');
    git('clone', '--quiet', '--bare', cwd, remote);
    mkdirSync(join(cwd, 'release-input/unpacked/package'), {recursive: true});
    writeFileSync(join(cwd, 'release-input/unpacked/package/package.json'), JSON.stringify({name: '@scope/public-fixture'}));
    writeFileSync(join(cwd, 'release-input/analysis.json'), JSON.stringify({candidate_sha: git('rev-parse', 'HEAD'), version: '1.0.0', tag: 'v1.0.0', notes: 'Public fixture notes'}));
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'bin/npm'), `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync('queries',JSON.stringify(process.argv.slice(2))+'\\n');console.log(${JSON.stringify(JSON.stringify(history))});process.exit(${status});\n`, {mode: 0o755});
    // The local engine fixture must not inherit a pull-request ref or publisher credentials.
    env.PATH = join(cwd, 'bin') + ':' + process.env.PATH;
    env.FIXTURE_REMOTE = pathToFileURL(remote).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import semanticRelease from ${JSON.stringify(engine)};
      import * as payload from ${JSON.stringify(payload)};
      import {writeFileSync} from 'node:fs';
      await semanticRelease({branches:['main'],tagFormat:'v'+'$'+'{version}',ci:false,repositoryUrl:process.env.FIXTURE_REMOTE,
        plugins:[{analyzeCommits:()=> 'major',generateNotes:()=> 'Public fixture notes'},
          {verifyRelease:(options,context)=>payload.verifyRelease?.(options,context)},
          {prepare:()=>writeFileSync('prepared','yes')}]
      },{cwd:process.cwd(),env:process.env});
    `], {cwd, encoding: 'utf8', env});
    return {run, tags: git('tag', '--list'), prepared: existsSync(join(cwd, 'prepared')), queries: existsSync(join(cwd, 'queries')) ? readFileSync(join(cwd, 'queries'), 'utf8') : ''};
  } finally {
    rmSync(cwd, {recursive: true, force: true});
    rmSync(remote, {recursive: true, force: true});
  }
}

test('a withdrawn npm version is rejected before prepare and tag creation for npm 11 and 12 responses', () => {
  const history = {'0.11.4': '2026-01-01T00:00:00Z', '1.0.0': '2025-06-18T15:29:29Z'};
  for (const response of [history, [history]]) {
    const result = release(response);
    assert.notEqual(result.run.status, 0, 'A previously used version must stop the real engine');
    assert.match(result.run.stderr, /already been used|previously published/i);
    assert.equal(result.prepared, false);
    assert.equal(result.tags, 'v0.11.4');
    assert.match(result.queries, /"@scope\/public-fixture","time"/);
  }
});

test('an unused version may proceed while ambiguous and failed history reads fail closed', () => {
  for (const [response, status, accepted] of [
    [{'0.11.4': '2026-01-01T00:00:00Z'}, 0, true],
    [{error: {code: 'E404'}}, 1, false],
    [{error: {code: 'E404', summary: 'Unpublished on 2026-01-01T00:00:00Z'}}, 1, false],
    [[{}, {}], 0, false],
    [{error: {code: 'E500'}}, 1, false],
  ]) {
    const result = release(response, status);
    assert.equal(result.run.status === 0, accepted, result.run.stderr);
    assert.equal(result.prepared, accepted);
    assert.equal(result.tags.includes('v1.0.0'), accepted);
  }
});
