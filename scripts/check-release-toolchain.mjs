import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runReleaseCommand, withReleaseToolchainSpan } from './release-toolchain-telemetry.mjs';

const tool = 'semantic-release';
const root = fileURLToPath(new URL('../', import.meta.url));
const config = new URL('../.github/actions/release-toolchain/', import.meta.url);

export function checkLockedRuntime({ nodePin, npmPin, node, npm, lock, installed }) {
  for (const [key, pin] of Object.entries({ node: nodePin, npm: npmPin })) {
    assert.match(pin ?? '', /^\d+\.\d+\.\d+$/, `${key} must be pinned to an exact version`);
  }
  const locked = lock?.packages?.[`node_modules/${tool}`];
  assert.ok(locked, `${tool} is missing from package-lock.json`);
  assert.ok(locked.engines?.node, `${tool} Node requirement is missing from package-lock.json`);
  assert.match(locked.version ?? '', /^\d+\.\d+\.\d+$/, `${tool} must have an exact stable lock`);
  const diagnostic = `${tool}@${locked.version} requires Node ${locked.engines.node}; found Node ${node}, npm ${npm}`;
  assert.equal(node, nodePin, `Release Node pin drift: ${diagnostic}`);
  assert.equal(npm, npmPin, `Release npm pin drift: ${diagnostic}`);
  assert.equal(installed?.version, locked.version, `Release CLI lock drift: ${diagnostic}`);
  assert.equal(installed?.engines?.node, locked.engines.node, `Release CLI engine metadata drift: ${diagnostic}`);
  return locked;
}

const command = (name, args) => runReleaseCommand(name, args, { cwd: root });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await withReleaseToolchainSpan('adg-release-toolchain-check', () => {
    const pin = name => readFileSync(new URL(`${name}-version`, config), 'utf8').trim();
    const lockBytes = readFileSync(new URL('../package-lock.json', import.meta.url));
    const installed = JSON.parse(readFileSync(new URL('../node_modules/semantic-release/package.json', import.meta.url)));
    const npm = command('npm', ['--version']);
    const lock = checkLockedRuntime({ nodePin: pin('node'), npmPin: pin('npm'), node: process.versions.node,
      npm, lock: JSON.parse(lockBytes), installed });
    const bin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.[tool];
    assert.ok(bin, 'Locked semantic-release does not declare its launcher');
    assert.equal(realpathSync(new URL('../node_modules/.bin/semantic-release', import.meta.url)),
      realpathSync(new URL(bin, new URL('../node_modules/semantic-release/', import.meta.url))),
      'semantic-release executable is not the installed locked launcher');
    // --version exercises startup; some CLI versions print the current project's version.
    command('npx', ['--no-install', tool, '--version']);
    console.log(JSON.stringify({ node: process.versions.node, npm, releaseTool: tool, releaseVersion: lock.version,
      nodeRequirement: lock.engines.node, testedSha: command('git', ['rev-parse', 'HEAD']), lockSha256: createHash('sha256').update(lockBytes).digest('hex') }));
  });
}
