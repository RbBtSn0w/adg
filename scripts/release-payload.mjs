// Stateless semantic-release payload hooks. Version selection belongs to the engine.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function digest(path) { return createHash('sha512').update(readFileSync(path)).digest('base64'); }
function payload(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const file = join(prefix, name), path = join(root, file);
    return statSync(path).isDirectory() ? payload(root, file) : file === 'package.json' ? [] : [[file, digest(path)]];
  });
}
export async function prepare(_options, { cwd, nextRelease }) {
  const input = join(cwd, 'release-input'), root = join(input, 'unpacked/package');
  const before = JSON.stringify(payload(root));
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = nextRelease.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Re-archive existing files directly: no npm pack, file filtering, or lifecycle hooks.
  execFileSync('tar', ['-czf', join(input, 'final.tgz'), '-C', join(input, 'unpacked'), 'package']);
  if (before !== JSON.stringify(payload(root))) throw Error('Prepared payload changed');
  writeFileSync(join(input, 'final.json'), JSON.stringify({ name: manifest.name, version: nextRelease.version, integrity: `sha512-${digest(join(input, 'final.tgz'))}` }));
}

export async function publish(_options, { cwd, env, nextRelease }) {
  const input = join(cwd, 'release-input'), archive = join(input, 'final.tgz');
  const metadata = JSON.parse(readFileSync(join(input, 'final.json'), 'utf8'));
  if (metadata.version !== nextRelease.version || metadata.integrity !== `sha512-${digest(archive)}`) throw Error('Final artifact mismatch');
  const receipts = join(input, 'receipts'); mkdirSync(receipts, { recursive: true });
  for (const [target, registry] of [['npm', 'https://registry.npmjs.org'], ['github-packages', 'https://npm.pkg.github.com']]) {
    const npmrc = join(input, `${target}.npmrc`);
    // Keep the GitHub token out of npmjs requests; npmjs uses trusted publishing.
    writeFileSync(npmrc, target === 'github-packages' ? '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n' : '');
    const runEnv = { ...env, NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_USERCONFIG: npmrc };
    const args = ['view', `${metadata.name}@${metadata.version}`, 'dist.integrity', '--json', '--registry', registry];
    const view = spawnSync('npm', args, { cwd: input, env: runEnv, encoding: 'utf8', timeout: 120000 });
    if (view.error) throw view.error;
    if (view.status === 0) {
      if (JSON.parse(view.stdout) !== metadata.integrity) throw Error(`${target}: existing version differs from final archive`);
    } else {
      let error; try { error = JSON.parse(view.stdout).error; } catch { /* fail closed below */ }
      if (error?.code !== 'E404') throw Error(`${target}: registry lookup failed: ${view.stderr}`);
      execFileSync('npm', ['publish', resolve(archive), '--ignore-scripts', '--access', 'public', '--tag', 'latest', '--registry', registry, ...(target === 'npm' ? ['--provenance'] : [])], {cwd: input, env: runEnv, stdio: 'inherit', timeout: 120000});
      const actual = execFileSync('npm', args, { cwd: input, env: runEnv, encoding: 'utf8', timeout: 120000 });
      if (JSON.parse(actual) !== metadata.integrity) throw Error(`${target}: published integrity mismatch`);
    }
    writeFileSync(join(receipts, `${target}.json`), JSON.stringify({...metadata, registry, candidate: env.CANDIDATE_SHA}));
  }
  writeFileSync(join(input, 'released-version'), `${nextRelease.version}\n`);
  return { name: 'npm and GitHub Packages', url: `https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}` };
}
