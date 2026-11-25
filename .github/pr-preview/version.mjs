import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseNpmView} from '../release-train/npm-view.mjs';

function stableVersion(value) {
  if (typeof value !== 'string' || value !== value.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a stable SemVer version');
  }
  return value.split('.').map(BigInt);
}

function compareCore(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function readStableLatest() {
  // Query a public tag without reusing project auth, scoped registries, or cached metadata.
  const directory = mkdtempSync(join(tmpdir(), 'adg-preview-latest-'));
  let result;
  try {
    result = spawnSync('npm', [
      'view', '@rbbtsn0w/adg', 'dist-tags', '--json',
      '--registry', 'https://registry.npmjs.org', '--prefer-online',
      '--fetch-retries=1', '--fetch-timeout=8000',
      '--cache', join(directory, 'cache'),
      '--userconfig', join(directory, 'user.npmrc'),
      '--globalconfig', join(directory, 'global.npmrc'),
    ], {cwd: directory, encoding: 'utf8', timeout: 25000});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
  if (result.error || result.status !== 0) throw new Error('Could not read npm latest');
  try {
    const latest = parseNpmView(result.stdout)?.latest;
    return {latest, core: stableVersion(latest)};
  } catch (cause) {
    throw new Error('npm latest is missing or has an invalid version', {cause});
  }
}

function prepare(manifestVersion, number, head, directory) {
  if (!/^[1-9]\d*$/.test(number) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('Invalid PR preview identity');
  }
  let base = stableVersion(manifestVersion.split(/[-+]/, 1)[0]);
  let baseline;
  try {
    baseline = readStableLatest();
  } catch (error) {
    console.error(`::warning::${error.message}. This preview is available as an artifact only.`);
  }
  if (baseline) {
    const minimum = [...baseline.core];
    minimum[2] += 1n;
    if (compareCore(base, minimum) < 0) base = minimum;
    writeFileSync(join(directory, 'stable-baseline.txt'), `${baseline.latest}\n`);
  }
  const prefix = head.slice(0, 7);
  const shortHead = /^0\d{6}$/.test(prefix) ? `g${prefix}` : prefix;
  writeFileSync(join(directory, 'version.txt'), `${base.join('.')}-dev.pr${number}.${shortHead}\n`);
}

function guard(version, baselinePath) {
  if (!existsSync(baselinePath)) throw new Error('Preview archive has no verified npm latest baseline');
  const preview = stableVersion(version.split('-', 1)[0]);
  const baseline = readFileSync(baselinePath, 'utf8').trim();
  if (compareCore(preview, stableVersion(baseline)) <= 0) {
    throw new Error(`Preview ${version} does not exceed its stable build baseline ${baseline}`);
  }
  const {latest, core} = readStableLatest();
  // A prerelease loses to a stable version with the same core.
  if (compareCore(preview, core) <= 0) {
    throw new Error(`Preview ${version} is not newer than npm latest ${latest}`);
  }
  console.log(`Preview ${version} is newer than npm latest ${latest}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'prepare' && args.length === 4) prepare(...args);
  else if (command === 'guard' && args.length === 2) guard(...args);
  else throw new Error('Invalid PR preview version command');
} catch (error) {
  const recovery = command === 'guard' ? '. Rerun PR CI with the current workflow to build a publishable preview.' : '';
  console.error(`${error.message}${recovery}`);
  process.exitCode = 1;
}
