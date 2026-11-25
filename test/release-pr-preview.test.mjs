import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {parse} from 'yaml';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/pr-preview-publish.yml', 'utf8'));
const head = 'c6ce45e17294c2061e00ce61e14bee4624c9216d';
const step = (job, id) => job.steps.find(candidate => candidate.id === id).run;

function fixture(t, manifest = '0.11.1') {
  const cwd = mkdtempSync(join(tmpdir(), 'adg-pr-preview-'));
  t.after(() => rmSync(cwd, {recursive: true, force: true}));
  mkdirSync(join(cwd, 'bin'));
  symlinkSync(resolve('.'), join(cwd, 'preview-tools'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({version: manifest}));
  writeFileSync(join(cwd, 'bin', 'git'), '#!/bin/sh\nprintf "%s\\n" "$PR_HEAD"\n', {mode: 0o755});
  writeFileSync(join(cwd, 'bin', 'gh'), '#!/bin/sh\nprintf "%s\\n" "$PR_HEAD"\n', {mode: 0o755});
  writeFileSync(join(cwd, 'bin', 'npm'), `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pkg') process.exit(13);
if (args[0] === 'publish') {
  writeFileSync(process.env.CALLS + '-published', '');
} else if (args[2] === 'dist-tags') {
  console.log(process.env.NPM_LATEST_JSON);
  process.exit(Number(process.env.NPM_LATEST_STATUS || 0));
} else if (args[0] === 'view' && existsSync(process.env.CALLS + '-published')) {
  console.log(JSON.stringify(process.env.PREVIEW_INTEGRITY));
} else {
  console.log('{"error":{"code":"E404"}}');
  process.exit(1);
}
`, {mode: 0o755});
  const env = {
    ...process.env, PATH: join(cwd, 'bin') + ':' + process.env.PATH,
    GITHUB_WORKSPACE: cwd, RUNNER_TEMP: cwd, GITHUB_OUTPUT: join(cwd, 'outputs'),
    GITHUB_REPOSITORY: 'RbBtSn0w/adg', PR_HEAD: head, PR_NUMBER: '200',
    CALLS: join(cwd, 'npm-calls'), NPM_LATEST_JSON: '{"latest":"1.0.2"}',
  };
  return {
    cwd, env,
    run(script, extraEnv = {}) {
      return spawnSync('bash', ['-eu', '-o', 'pipefail', '-c', script], {
        cwd, env: {...env, ...extraEnv}, encoding: 'utf8',
      });
    },
    calls() {
      if (!existsSync(env.CALLS)) return [];
      return readFileSync(env.CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    },
  };
}

function prepare(preview, env) {
  const result = preview.run(step(ci.jobs['pr-preview'], 'pack'), env);
  // Stop at manifest stamping, before the pack step invokes dependency tooling.
  assert.equal(result.status, 13, result.stderr);
  return result;
}

test('the actual PR pack step stamps a version newer than npm latest', t => {
  const preview = fixture(t);
  prepare(preview);
  assert.deepEqual(preview.calls().find(args => args[0] === 'pkg'),
    ['pkg', 'set', 'version=1.0.3-dev.pr200.c6ce45e']);
  assert.equal(readFileSync(join(preview.cwd, 'pr-preview', 'stable-baseline.txt'), 'utf8'), '1.0.2\n');
});

test('the PR core can name a newer release and numeric SHA prefixes stay valid', t => {
  const preview = fixture(t, '2.0.0-alpha.1');
  prepare(preview, {PR_HEAD: '0123456' + 'a'.repeat(33), NPM_LATEST_JSON: '[{"latest":"1.0.2"}]'});
  assert.deepEqual(preview.calls().find(args => args[0] === 'pkg'),
    ['pkg', 'set', 'version=2.0.0-dev.pr200.g0123456']);
});

for (const [label, env] of [
  ['missing latest', {NPM_LATEST_JSON: '{}'}],
  ['prerelease latest', {NPM_LATEST_JSON: '{"latest":"1.0.2-rc.1"}'}],
  ['malformed latest', {NPM_LATEST_JSON: '{"latest":"1.0.2\\n"}'}],
  ['failed lookup', {NPM_LATEST_STATUS: '1'}],
]) {
  test(`${label} leaves a downloadable preview without a publishable baseline`, t => {
    const preview = fixture(t);
    const result = prepare(preview, env);
    assert.match(result.stderr, /available as an artifact only/);
    assert.equal(existsSync(join(preview.cwd, 'pr-preview', 'stable-baseline.txt')), false);
    assert.deepEqual(preview.calls().find(args => args[0] === 'pkg'),
      ['pkg', 'set', 'version=0.11.1-dev.pr200.c6ce45e']);
  });
}

const version = '1.0.3-dev.pr200.c6ce45e';

test('the preview CLI records privacy-safe npm caller spans for prepare and guard', t => {
  const preview = fixture(t);
  const bootstrap = join(preview.cwd, 'capture-spans.cjs');
  const report = join(preview.cwd, 'spans.json');
  writeFileSync(bootstrap, `
const requireFromRepo = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});
const {NodeTracerProvider} = requireFromRepo('@opentelemetry/sdk-trace-node');
const {InMemorySpanExporter, SimpleSpanProcessor} = requireFromRepo('@opentelemetry/sdk-trace-base');
const exporter = new InMemorySpanExporter();
new NodeTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter)]}).register();
process.once('beforeExit', () => {
  const spans = exporter.getFinishedSpans().map(({name, kind, attributes, status, events}) =>
    ({name, kind, attributes, status, events}));
  require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify(spans));
});
`);
  const helper = resolve('.github/pr-preview/version.mjs');
  const run = (args, env) => spawnSync(process.execPath, ['--require', bootstrap, helper, ...args], {
    cwd: preview.cwd, env: {...preview.env, OTEL_SDK_DISABLED: 'true', ...env}, encoding: 'utf8',
  });

  const prepared = run(['prepare', '0.11.1', '200', head, preview.cwd]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const prepareSpans = JSON.parse(readFileSync(report, 'utf8'));
  const success = prepareSpans.find(span => span.name === 'npm');
  assert.ok(success, 'prepare must record an npm caller span');
  assert.equal(success.kind, SpanKind.CLIENT);
  assert.equal(success.attributes['process.executable.name'], 'npm');
  assert.equal(success.attributes['process.exit.code'], 0);
  assert.ok(success.attributes['process.pid'] > 0);

  const args = ['guard', version, join(preview.cwd, 'stable-baseline.txt')];
  const rejected = run(args, {NPM_LATEST_STATUS: '7'});
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /Could not read npm latest/);
  const guardSpans = JSON.parse(readFileSync(report, 'utf8'));
  const failure = guardSpans.find(span => span.name === 'npm');
  assert.ok(failure, 'guard must record an npm caller span before failing');
  assert.equal(failure.kind, SpanKind.CLIENT);
  assert.equal(failure.attributes['process.exit.code'], 7);
  assert.equal(failure.attributes['error.type'], 'EXIT_CODE_7');
  assert.equal(failure.status.code, SpanStatusCode.ERROR);
  assert.equal(guardSpans.find(span => span.kind === SpanKind.INTERNAL)?.attributes['process.exit.code'], 1);

  const artifactOnly = join(preview.cwd, 'artifact-only');
  mkdirSync(artifactOnly);
  const fallback = run(['prepare', '0.11.1', '200', head, artifactOnly], {NPM_LATEST_JSON: '{}'});
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stderr, /available as an artifact only/);
  const fallbackSpans = JSON.parse(readFileSync(report, 'utf8'));
  const fallbackSpan = fallbackSpans.find(span => span.kind === SpanKind.INTERNAL);
  assert.equal(fallbackSpan?.attributes['process.exit.code'], 0);
  assert.equal(fallbackSpan?.events.find(event => event.name === 'adg.pr_preview.baseline_lookup_failed')?.attributes['error.type'], 'InvalidNpmLatest');

  for (const spans of [prepareSpans, guardSpans, fallbackSpans]) {
    assert.doesNotMatch(JSON.stringify(spans), /process\.executable\.path|adg-preview-latest-|stable-baseline\.txt|registry\.npmjs\.org/);
  }
});

function seal(preview, baseline = '1.0.2', sealedVersion = version) {
  mkdirSync(join(preview.cwd, 'package'));
  writeFileSync(join(preview.cwd, 'package', 'package.json'), JSON.stringify({
    name: '@rbbtsn0w/adg', version: sealedVersion, publishConfig: {access: 'public'},
  }));
  execFileSync('tar', ['-czf', 'adg-pr-preview.tgz', 'package/package.json'], {cwd: preview.cwd});
  const archive = readFileSync(join(preview.cwd, 'adg-pr-preview.tgz'));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  writeFileSync(join(preview.cwd, 'SHA256SUMS'), `${sha256}  adg-pr-preview.tgz\n`);
  writeFileSync(join(preview.cwd, 'commit.txt'), head + '\n');
  writeFileSync(join(preview.cwd, 'version.txt'), sealedVersion + '\n');
  if (baseline) writeFileSync(join(preview.cwd, 'stable-baseline.txt'), baseline + '\n');
  return 'sha512-' + createHash('sha512').update(archive).digest('base64');
}

test('the actual publish workflow refuses an artifact without a build baseline', t => {
  const preview = fixture(t);
  seal(preview, '');
  const result = preview.run(step(publish.jobs.publish, 'verify'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no verified npm latest baseline/);
  assert.equal(existsSync(join(preview.cwd, 'publish-preview.sh')), false);
});

test('a prerelease with the same core as the build baseline cannot be published', t => {
  const preview = fixture(t);
  seal(preview, '1.0.2', '1.0.2-dev.pr200.c6ce45e');
  const result = preview.run(step(publish.jobs.publish, 'verify'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exceed its stable build baseline 1\.0\.2/);
  assert.deepEqual(preview.calls(), []);
});

for (const [id, registry] of [['npm', 'https://registry.npmjs.org'], ['mirror', 'https://npm.pkg.github.com']]) {
  test(`${id} rechecks latest immediately before publishing the verified archive`, t => {
    const preview = fixture(t);
    const integrity = seal(preview);
    const verified = preview.run(step(publish.jobs.publish, 'verify'));
    assert.equal(verified.status, 0, verified.stderr);
    const command = step(publish.jobs.publish, id);
    const env = {PREVIEW_VERSION: version, PREVIEW_INTEGRITY: integrity};
    const stale = preview.run(command, {...env, NPM_LATEST_JSON: '{"latest":"1.0.3"}'});
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /not newer than npm latest 1\.0\.3.*Rerun PR CI/);
    const unavailable = preview.run(command, {...env, NPM_LATEST_STATUS: '1'});
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Could not read npm latest/);
    assert.equal(preview.calls().some(args => args[0] === 'publish'), false);
    const fresh = preview.run(command, env);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(preview.calls().filter(args => args[0] === 'publish'), [
      ['publish', './adg-pr-preview.tgz', '--ignore-scripts', '--access', 'public', '--tag', 'next', '--registry', registry],
    ]);
  });
}
