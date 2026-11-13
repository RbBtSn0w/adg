import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPipelinePlan } from '../.github/release-train/pipeline-contract.mjs';

const candidate = 'a'.repeat(40);
const version = '2.0.0';
const sha256 = 'b'.repeat(64);
const names = ['npm', 'github-packages', 'github-release'];
const config = {
  schema_version: 2, protocol_version: 1, profile: 'npm', cadence: {},
  intended_targets: names,
  pipeline: {
    stages: [{
      id: 'observe', implementation: 'public-fixture', operation: 'observe',
      effect: 'read', depends_on: [], inputs: [], outputs: [],
      execution: { provider: 'fixture', job: 'observe' },
    }],
    goals: names.map(id => ({
      id, stages: ['observe'], asynchronous: false, recovery: 'supported',
    })),
  },
};
const pipeline = createPipelinePlan({
  config,
  identity: { repository: 'owner/fixture', candidate_sha: candidate, version, tag: 'v2.0.0', notes: 'Public fixture notes' },
});

function finalize(order, receiptHash = sha256, verificationEvidence = 'pipeline', verificationFields = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-finalize-sealed-'));
  try {
    mkdirSync(join(cwd, '.github'));
    writeFileSync(join(cwd, '.github/release-train.json'), JSON.stringify(config));
    const base = {
      schema_version: 2, candidate_sha: candidate, version,
      baseline_tag: 'v1.0.0', analysis: 'success', verification: 'passed',
    };
    const sealed = {
      artifact_id: '34', source_run_id: '12', source_attempt: '1',
      candidate_sha: candidate, version, repository: 'owner/fixture',
      sha256, tag: 'v2.0.0', tag_format: 'v${version}', pipeline,
    };
    const sources = {
      verify: { ...base,
        targets: Object.fromEntries(names.map(name => [name, { status: 'not-run' }])),
        artifacts: [{ ...(verificationEvidence === 'digest' ? { candidate_sha: candidate, version, sha256, ...verificationFields } : { candidate_sha: candidate, version, pipeline }), ...verificationFields }],
      },
      release: { ...base,
        targets: Object.fromEntries(names.map(name => [name, {
          status: 'completed', candidate_sha: candidate, version, sha256: receiptHash,
          observed_at: '2026-01-01T00:00:00Z', remote_id: name + '@' + version,
          latest_version: version, channel_observed_at: '2026-01-01T00:00:00Z',
        }])),
        artifacts: [sealed],
      },
    };
    for (const [directory, source] of Object.entries(order)) {
      const path = join(cwd, 'release-observations', directory);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'release-result.json'), JSON.stringify(sources[source]));
    }
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'bin/gh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const run = spawnSync(process.execPath, [resolve('scripts/release-finalize.mjs')], {
      cwd, encoding: 'utf8',
      env: {
        ...process.env, PATH: join(cwd, 'bin') + ':' + process.env.PATH,
        GITHUB_SHA: candidate, GITHUB_REPOSITORY: 'owner/fixture',
        GITHUB_STEP_SUMMARY: '', RELEASE_ENABLED: 'true',
        FINAL_VERIFY_RESULT: 'success', FINAL_RELEASE_RESULT: 'success',
        FINAL_AUDIT_RESULT: 'success', FINAL_RECOVER_RESULT: 'skipped',
      },
    });
    return { run, result: JSON.parse(readFileSync(join(cwd, 'release-result.json'))) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('pipeline-only verification retains the completed sealed publication in either producer order', () => {
  for (const order of [
    { release: 'release', verify: 'verify' },
    { first: 'verify', last: 'release' },
  ]) {
    const { run, result } = finalize(order);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result.publication, 'completed');
    assert.equal(result.artifacts[0].sha256, sha256);
    assert.equal(result.artifacts[0].artifact_id, '34');
    for (const name of names) assert.equal(result.targets[name].status, 'completed');
  }
});

test('digest-only verification cannot replace sealed artifact lineage in either order', () => {
  for (const order of [{ release: 'release', verify: 'verify' }, { first: 'verify', last: 'release' }]) {
    const { run, result } = finalize(order, sha256, 'digest');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result.artifacts[0].artifact_id, '34');
    assert.equal(result.artifacts[0].source_run_id, '12');
    assert.deepEqual(result.artifacts[0].pipeline, pipeline);
  }
});

test('malformed artifact identities cannot impersonate sealed evidence or abort reporting', () => {
  for (const identity of [
    { artifact_id: ['99'], source_run_id: ['98'] },
    { artifact_id: { toString: null }, source_run_id: '98' },
    { artifact_id: '99', source_run_id: { toString: null } },
  ]) {
    const { run, result } = finalize({ release: 'release', verify: 'verify' }, sha256, 'digest', identity);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(result.artifacts[0].artifact_id, '34');
    assert.equal(result.artifacts[0].source_run_id, '12');
  }
});

test('retained sealed evidence does not confirm receipts for different bytes', () => {
  const { run, result } = finalize({ release: 'release', verify: 'verify' }, 'c'.repeat(64));
  assert.equal(run.status, 1);
  assert.notEqual(result.publication, 'completed');
  for (const name of names) assert.equal(result.targets[name].status, 'unknown');
});
