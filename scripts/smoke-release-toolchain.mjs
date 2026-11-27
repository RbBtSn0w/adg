import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runReleaseCommand, withReleaseToolchainSpan } from './release-toolchain-telemetry.mjs';

await withReleaseToolchainSpan('adg-release-toolchain-smoke', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sandbox = mkdtempSync(join(tmpdir(), 'adg-release-toolchain-'));
  const origin = join(sandbox, 'origin.git');
  const cwd = join(sandbox, 'fixture');
  const env = {
    PATH: process.env.PATH,
    HOME: sandbox,
    XDG_CONFIG_HOME: sandbox,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    RELEASE_TOOLS: root,
    CI: 'true',
  };
  const run = (dir, file, ...args) => runReleaseCommand(file, args, { cwd: dir, env });
  const git = (...args) => run(cwd, 'git', ...args);
  const pluginNames = [
    './.github/release-train/commit-semantics.mjs',
    './.github/release-train/release-commit-analyzer.mjs',
    './.github/release-train/release-notes-generator.mjs',
  ];
  try {
    const production = JSON.parse(readFileSync(join(root, '.releaserc.json'), 'utf8'));
    const name = entry => Array.isArray(entry) ? entry[0] : entry;
    const plugins = production.plugins.filter(entry => pluginNames.includes(name(entry)));
    assert.deepEqual(plugins.map(name), pluginNames, 'Review changed production analysis hooks before updating the fixture');
    const isolatedPlugins = plugins.map(entry => Array.isArray(entry) ? [resolve(root, entry[0]), entry[1]] : resolve(root, entry));
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules/semantic-release/package.json'), 'utf8'));
    const bin = resolve(root, 'node_modules/semantic-release', typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['semantic-release']);
    run(sandbox, 'git', 'init', '--bare', '-b', 'main', origin);
    run(sandbox, 'git', 'init', '-b', 'main', cwd);
    git('config', 'user.name', 'Release toolchain fixture');
    git('config', 'user.email', 'release-fixture@example.invalid');
    git('remote', 'add', 'origin', origin);
    writeFileSync(join(cwd, '.releaserc.json'), JSON.stringify({
      branches: ['main'], repositoryUrl: pathToFileURL(origin).href, tagFormat: production.tagFormat, plugins: isolatedPlugins,
    }));
    git('add', '.releaserc.json');
    git('commit', '-m', 'chore: baseline');
    git('tag', '1.0.0');
    git('push', '--tags', 'origin', 'main');
    for (const [message, expected] of [
      ['chore: update internal metadata', /no relevant changes|no release is published/i],
      ['fix: correct fixture behavior', /(?:next release version is|Published release) 1\.0\.1\b/i],
    ]) {
      git('commit', '--allow-empty', '-m', message);
      git('push', 'origin', 'main');
      const refs = git('ls-remote', 'origin');
      const tags = git('tag', '--list');
      const output = run(cwd, process.execPath, bin, '--dry-run', '--ci');
      assert.match(output, expected);
      assert.equal(git('ls-remote', 'origin'), refs, 'Dry run must not write origin refs');
      assert.equal(git('tag', '--list'), tags, 'Dry run must not create local tags');
      console.log(`Verified: ${message}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
