import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
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

test('release toolchain entrypoints emit bounded INTERNAL and CLIENT success/failure spans', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'toolchain-span-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pathMarker = 'private-fixture-directory';
  const secret = 'private-fixture-secret';
  const bin = join(cwd, pathMarker);
  mkdirSync(bin);
  const report = join(cwd, 'spans.json');
  const bootstrap = join(cwd, 'capture.cjs');
  const pin = readFileSync(new URL('../.github/actions/release-toolchain/node-version', import.meta.url), 'utf8').trim();
  writeFileSync(bootstrap, `
const req = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});
const {NodeTracerProvider} = req('@opentelemetry/sdk-trace-node');
const {InMemorySpanExporter, SimpleSpanProcessor} = req('@opentelemetry/sdk-trace-base');
const exporter = new InMemorySpanExporter();
new NodeTracerProvider({spanProcessors: [new SimpleSpanProcessor(exporter)]}).register();
// Simulate the configured Node pin for this telemetry test; named CI boots the real pin.
Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(pin)} });
if (process.env.SMOKE_EXECUTABLE) process.execPath = process.env.SMOKE_EXECUTABLE;
process.once('beforeExit', () => {
  const spans = exporter.getFinishedSpans().map(({name, kind, attributes, status, events, parentSpanContext}) =>
    ({name, kind, attributes, status, events, parentSpanId: parentSpanContext?.spanId}));
  require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify(spans));
});
`);
  const npmPin = readFileSync(new URL('../.github/actions/release-toolchain/npm-version', import.meta.url), 'utf8').trim();
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('npm', `printf '%s\\n' '${npmPin}'`);
  stub('npx', `if [ -n "$FAIL_LAUNCHER" ]; then echo '${secret}' >&2; exit 7; fi`);
  stub('git', `echo '${secret}' >&2; exit 9`);
  const capture = (script, extras = {}) => {
    rmSync(report, { force: true });
    const env = {
      ...process.env, ...extras, OTEL_SDK_DISABLED: 'true', PATH: bin + delimiter + process.env.PATH,
      // Ambient telemetry sampling must not override the local in-memory provider.
      OTEL_TRACES_SAMPLER: 'always_on',
    };
    const result = spawnSync(process.execPath, ['--require', bootstrap, resolve('scripts', script), secret], {
      cwd, env, encoding: 'utf8', timeout: 30_000,
    });
    const evidence = readFileSync(report, 'utf8');
    assert.doesNotMatch(evidence, new RegExp(`${secret}|${pathMarker}|process\\.command_args|process\\.executable\\.path`));
    const spans = JSON.parse(evidence);
    assert.ok(spans.filter(span => span.kind === SpanKind.CLIENT).every(span => span.parentSpanId), 'caller spans must be children');
    return { result, spans };
  };
  const assertSpan = (span, name, kind, code, error) => {
    assert.equal(span?.name, name);
    assert.equal(span.kind, kind);
    assert.equal(span.attributes['process.executable.name'], name);
    assert.equal(span.attributes['process.exit.code'], code);
    assert.equal(span.attributes['error.type'], error);
    if (error) assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.deepEqual(span.events, []);
  };
  const check = capture('check-release-toolchain.mjs', { FAIL_LAUNCHER: '1' });
  assert.equal(check.result.status, 1, check.result.stderr);
  assert.match(check.result.stderr, new RegExp(secret), 'diagnostic remains available outside telemetry');
  assertSpan(check.spans.find(s => s.kind === SpanKind.INTERNAL), 'adg-release-toolchain-check', SpanKind.INTERNAL, 1, 'ReleaseToolchainError');
  assertSpan(check.spans.find(s => s.name === 'npm'), 'npm', SpanKind.CLIENT, 0, undefined);
  assertSpan(check.spans.find(s => s.name === 'npx'), 'npx', SpanKind.CLIENT, 7, 'EXIT_CODE_7');

  const smoke = capture('smoke-release-toolchain.mjs');
  assert.equal(smoke.result.status, 1, smoke.result.stderr);
  assertSpan(smoke.spans.find(s => s.kind === SpanKind.INTERNAL), 'adg-release-toolchain-smoke', SpanKind.INTERNAL, 1, 'ReleaseToolchainError');
  assertSpan(smoke.spans.find(s => s.name === 'git'), 'git', SpanKind.CLIENT, 9, 'EXIT_CODE_9');

  stub('git', "printf '%s\\n' 'synthetic-sha'");
  const ok = capture('check-release-toolchain.mjs');
  assert.equal(ok.result.status, 0, ok.result.stderr);
  assertSpan(ok.spans.find(s => s.kind === SpanKind.INTERNAL), 'adg-release-toolchain-check', SpanKind.INTERNAL, 0, undefined);
  assertSpan(ok.spans.find(s => s.name === 'git'), 'git', SpanKind.CLIENT, 0, undefined);

  rmSync(join(bin, 'git'));
  // The smoke fixture uses real Git with a synthetic release launcher here.
  // The named gate separately executes the locked launcher without stubs.
  stub('node', `case "$(git log -1 --format=%s)" in
  fix:*) echo 'The next release version is 1.0.1' ;;
  *) echo 'no relevant changes' ;;
esac`);
  const smokeOk = capture('smoke-release-toolchain.mjs', { SMOKE_EXECUTABLE: join(bin, 'node') });
  assert.equal(smokeOk.result.status, 0, smokeOk.result.stderr);
  assertSpan(smokeOk.spans.find(s => s.kind === SpanKind.INTERNAL), 'adg-release-toolchain-smoke', SpanKind.INTERNAL, 0, undefined);
  const nodeSpans = smokeOk.spans.filter(s => s.name === 'node');
  assert.equal(nodeSpans.length, 2, 'both fixtures must execute the launcher');
  for (const span of nodeSpans) assertSpan(span, 'node', SpanKind.CLIENT, 0, undefined);
});
