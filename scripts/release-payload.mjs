import {verifyLatest} from '../.github/release-train/npm-channel.mjs';
import {recoveryTag,cleanRecoveryTag,reconcileLatest} from '../.github/release-train/npm-recovery-tag.mjs';
// Stateless semantic-release payload hooks. Version selection belongs to the engine.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

function digest(path) { return createHash('sha512').update(readFileSync(path)).digest('base64'); }
function payload(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const file = join(prefix, name), path = join(root, file);
    return statSync(path).isDirectory() ? payload(root, file) : file === 'package.json' ? [] : [[file, digest(path)]];
  });
}
function assertLiveMain(cwd, env) {
  const candidate = env.CANDIDATE_SHA;
  if (!/^[a-f0-9]{40}$/.test(candidate || '') || !/^[^/]+\/[^/]+$/.test(env.GITHUB_REPOSITORY || '')) throw Error('Main guard requires candidate and repository');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, env, encoding: 'utf8', timeout: 10000 }).trim();
  const live = execFileSync('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`, '--jq', '.object.sha'], { cwd, env, encoding: 'utf8', timeout: 10000 }).trim();
  if (head !== candidate || live !== candidate) throw Error('Main changed or could not be read; verify a fresh candidate.');
}
export async function prepare(_options, { cwd, env = process.env, nextRelease }) {
  const input = join(cwd, 'release-input'), root = join(input, 'unpacked/package');
  // The verified engine decision is mandatory and immutable across prepare.
  const analysis = JSON.parse(readFileSync(join(input, 'analysis.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(analysis.candidate_sha || '') || analysis.candidate_sha !== env.CANDIDATE_SHA || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(analysis.version || '') || analysis.version !== nextRelease.version || typeof analysis.tag !== 'string' || !analysis.tag || analysis.tag !== nextRelease.gitTag) throw Error('Engine release differs from verified analysis');
  if (typeof analysis.notes !== 'string' || typeof nextRelease.notes !== 'string' || analysis.notes !== nextRelease.notes) throw Error('Release notes changed after analysis; analyze and verify a fresh candidate');
  const before = JSON.stringify(payload(root));
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = nextRelease.version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Re-archive existing files directly: no npm pack, file filtering, or lifecycle hooks.
  execFileSync('tar', ['-czf', join(input, 'final.tgz'), '-C', join(input, 'unpacked'), 'package']);
  if (before !== JSON.stringify(payload(root))) throw Error('Prepared payload changed');
  writeFileSync(join(input, 'final.json'), JSON.stringify({ name: manifest.name, version: nextRelease.version, integrity: `sha512-${digest(join(input, 'final.tgz'))}`, sha256: createHash('sha256').update(readFileSync(join(input, 'final.tgz'))).digest('hex'), candidate_sha: env.CANDIDATE_SHA, repository: env.GITHUB_REPOSITORY, source_run_id: env.GITHUB_RUN_ID, source_attempt: env.GITHUB_RUN_ATTEMPT, operation: 'release', tag: nextRelease.gitTag, baseline_tag: analysis.baseline_tag || null }));
  assertLiveMain(cwd, env);
}

export async function publish(_options, { cwd, env, nextRelease }) {
  if(env.RELEASE_ENABLED!=='true')throw Error('Publication remains disabled');
  const input = join(cwd, 'release-input'), archive = join(input, 'final.tgz');
  const metadata = JSON.parse(readFileSync(join(input, 'final.json'), 'utf8'));
  if (metadata.version !== nextRelease.version || metadata.integrity !== `sha512-${digest(archive)}`) throw Error('Final artifact mismatch');
  // The tag fixes identity; main may advance while these original bytes are published.
  if(!_options.recovery){
    const analysis=JSON.parse(readFileSync(join(input,'analysis.json'),'utf8'));
    if(metadata.candidate_sha!==env.CANDIDATE_SHA||metadata.candidate_sha!==analysis.candidate_sha||metadata.version!==analysis.version||metadata.tag!==analysis.tag||metadata.tag!==nextRelease.gitTag||(nextRelease.gitHead!==undefined&&nextRelease.gitHead!==metadata.candidate_sha)||typeof analysis.notes!=='string'||analysis.notes!==nextRelease.notes)throw Error('Publication identity differs from the original sealed analysis');
  }
  const receipts = join(input, 'receipts'); mkdirSync(receipts, { recursive: true });
  const deferredErrors=[];
  for (const [target, registry] of [['npm', 'https://registry.npmjs.org'], ['github-packages', 'https://npm.pkg.github.com']]) {
    const receiptPath=join(receipts,`${target}.json`);
    if(existsSync(receiptPath))unlinkSync(receiptPath);
    const npmrc = join(input, `${target}.npmrc`);
    // Keep the GitHub token out of npmjs requests; npmjs uses trusted publishing.
    writeFileSync(npmrc, target === 'github-packages' ? '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n' : '');
    const runEnv = { ...env, NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_USERCONFIG: npmrc };
    const tagOptions={cwd:input,env:runEnv,registry};
    const distributionTag=_options.recovery?recoveryTag(metadata,tagOptions):'latest';
    const args = ['view', `${metadata.name}@${metadata.version}`, 'dist.integrity', '--json', '--registry', registry];
    const view = spawnSync('npm', args, { cwd: input, env: runEnv, encoding: 'utf8', timeout: 120000 });
    if (view.error) throw view.error;
    if (view.status === 0) {
      if (JSON.parse(view.stdout) !== metadata.integrity) throw Error(`${target}: existing version differs from final archive`);
    } else {
      let error; try { error = JSON.parse(view.stdout).error; } catch { /* fail closed below */ }
      if (error?.code !== 'E404') throw Error(`${target}: registry lookup failed: ${view.stderr}`);
      execFileSync('npm', ['publish', resolve(archive), '--ignore-scripts', '--access', 'public', '--tag', distributionTag, '--registry', registry, ...(target === 'npm' ? ['--provenance'] : [])], {cwd: input, env: runEnv, stdio: 'inherit', timeout: 120000});
      let verified = false;
      let detail = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const actual = spawnSync('npm', args, { cwd: input, env: runEnv, encoding: 'utf8', timeout: 120000 });
        try { verified = !actual.error && actual.status === 0 && JSON.parse(actual.stdout) === metadata.integrity; }
        catch { /* Malformed or not-yet-visible registry metadata remains unverified. */ }
        if (verified) break;
        detail = actual.error?.message || actual.stderr || actual.stdout;
        if (attempt < 2) await new Promise(done => setTimeout(done, 1000 * (attempt + 1)));
      }
      if (!verified) throw Error(`${target}: published integrity could not be verified: ${detail}`);
    }
    const bytesObservedAt=new Date().toISOString();
    let channel;
    try{
      // Safe recovery helpers observe latest and retain temporary tags; they never add/remove tags.
      if(_options.recovery){reconcileLatest(metadata,tagOptions);cleanRecoveryTag(metadata,distributionTag,tagOptions);}
      channel=verifyLatest(metadata,tagOptions);
    }catch(error){
      writeFileSync(receiptPath,JSON.stringify({...metadata,registry,status:'unknown',observed_at:bytesObservedAt,remote_id:`${metadata.name}@${metadata.version}`,url:target==='npm'?`https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}`:`https://github.com/${metadata.repository}/packages`,bytes_verified:true,channel_blocked:true,reason:`Latest channel is not confirmed: ${error.message}`}));
      // Original-byte recovery can continue safe targets; normal publication remains fail-fast.
      if(!(_options.recovery&&_options.deferChannelErrors))throw error;
      deferredErrors.push(new Error(`${target}: ${error.message}`,{cause:error}));
      continue;
    }
    writeFileSync(join(receipts, `${target}.json`), JSON.stringify({...metadata, status: 'completed', bytes_verified:true, registry, latest_version:channel.latest_version, channel_observed_at:channel.observed_at, observed_at: new Date().toISOString(), remote_id: `${metadata.name}@${metadata.version}`, url: target === 'npm' ? `https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}` : `https://github.com/${metadata.repository}/packages`, candidate_sha: metadata.candidate_sha}));
  }
  if(!deferredErrors.length)writeFileSync(join(input, 'released-version'), `${nextRelease.version}\n`);
  return { name: 'npm and GitHub Packages', url: `https://www.npmjs.com/package/${metadata.name}/v/${metadata.version}`, ...(_options.recovery&&_options.deferChannelErrors?{deferred_errors:deferredErrors}:{}) };
}
