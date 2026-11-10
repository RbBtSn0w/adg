import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(process.env.RELEASE_TOOLS ? join(process.env.RELEASE_TOOLS, 'package.json') : import.meta.url);
const yaml = require('yaml');
function childEnv() {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('ordinary CI executes the actual release contract without publishing authority', () => {
  const ci = yaml.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const matches = Object.values(ci.jobs).flatMap(job => (job.steps || []).filter(step => step.id === 'release_contracts').map(step => ({job, step})));
  assert.equal(matches.length, 1, 'One existing PR/main environment must run the actual release contract');
  const {job, step} = matches[0];
  assert.deepEqual(job.permissions ?? ci.permissions, {contents: 'read'});
  assert.ok(!step['continue-on-error']);
  const result = spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', step.run], {cwd: root, env: childEnv(), encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('the same release test entrypoint discovers a newly added failing test', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'))).scripts?.['test:release'];
  assert.equal(typeof script, 'string', 'CI and candidate verification need one complete release test entrypoint');
  const cwd = mkdtempSync(join(tmpdir(), 'release-ci-collection-'));
  try {
    const folder = basename(dirname(fileURLToPath(import.meta.url))) === 'tests' ? 'tests' : 'test';
    mkdirSync(join(cwd, folder));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({private: true, scripts: {'test:release': script}}));
    const pass = "import test from 'node:test'; test('release collection fixture',()=>{});\n";
    writeFileSync(join(cwd, folder, 'branch_release_analysis.test.mjs'), pass);
    const prefix = folder === 'tests' ? 'release_' : 'release-';
    writeFileSync(join(cwd, folder, prefix + 'pass.test.mjs'), pass);
    const run = () => spawnSync(process.env.RELEASE_NPM_EXECUTABLE || 'npm', ['run', 'test:release'], {cwd, env: childEnv(), encoding: 'utf8', timeout: 30000});
    let result = run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    writeFileSync(join(cwd, folder, prefix + 'new.test.mjs'), "import test from 'node:test'; test('new release regression',()=>{throw Error('release-collection-sentinel');});\n");
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /release-collection-sentinel/);
  } finally {rmSync(cwd, {recursive: true, force: true});}
});
