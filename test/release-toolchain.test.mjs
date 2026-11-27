import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { checkLockedRuntime } from '../scripts/check-release-toolchain.mjs';

const installed = { version: '26.0.1', engines: { node: '>=26.13' } };
const fixture = { nodePin: '26.13.1', node: '26.13.1', npmPin: '12.2.2', npm: '12.2.2',
  lock: { packages: { 'node_modules/semantic-release': installed } }, installed };
test('release Node, npm, version and engine must agree with exact checked-in metadata', () => {
  assert.equal(checkLockedRuntime(fixture), installed);
  for (const [delta, expected] of [
    [{ nodePin: '26' }, /exact version/],
    [{ npmPin: '^12.2.2' }, /exact version/],
    [{ node: '24.22.3' }, /26.0.1 requires Node >=26.13; found Node 24.22.3/],
    [{ npm: '12.2.1' }, /npm pin drift/],
    [{ lock: {} }, /missing from package-lock/],
    [{ lock: { packages: { 'node_modules/semantic-release': { version: '26.0.1' } } } }, /Node requirement is missing/],
    [{ installed: { ...installed, version: '25.0.9' } }, /CLI lock drift/],
    [{ installed: { ...installed, engines: { node: '>=24' } } }, /engine metadata drift/],
  ]) assert.throws(() => checkLockedRuntime({ ...fixture, ...delta }), expected);
});

test('read-only gate and stable workflow use the same install action without skipping relevant PRs', () => {
  const read = name => parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const ci = read('ci');
  const gate = ci.jobs['release-toolchain'];
  assert.equal(gate.name, 'Release toolchain');
  assert.equal(gate.if, undefined);
  assert.deepEqual(gate.permissions, { contents: 'read' });
  assert.equal(gate.steps[0].with['persist-credentials'], false);
  assert.equal(ci.on.pull_request.paths, undefined);
  assert.deepEqual(ci.on.merge_group.types, ['checks_requested']);
  const shared = './.github/actions/release-toolchain';
  for (const job of [gate, ...['verify', 'release', 'recover'].map(name => read('release').jobs[name])]) {
    assert.equal(job.steps.filter(step => step.uses === shared).length, 1);
  }
});
