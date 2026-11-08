// Recovery uses current trusted workflow code and the original sealed publication bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyRecoverySource } from './recovery-source.mjs';
import { verifyNpm } from './npm-release-adapter.mjs';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function validatePayload(metadata, archive) {
  if(metadata.schema_version!==1||metadata.verification!=='passed'||metadata.release_needed!==true||metadata.operation!=='release')throw Error('Original verified release plan is required');
  if(!/^[a-f0-9]{40}$/.test(metadata.candidate_sha||'')||!/^\d+\.\d+\.\d+$/.test(metadata.version||'')||!metadata.tag||!metadata.name||typeof metadata.notes!=='string')throw Error('Invalid original release identity');
  if(metadata.sha256!==sha256(archive)||metadata.integrity!=='sha512-'+createHash('sha512').update(readFileSync(archive)).digest('base64'))throw Error('Original sealed archive digest mismatch');
  const manifest=JSON.parse(execFileSync('tar',['-xOf',archive,'package/package.json'],{encoding:'utf8'}));
  if(manifest.name!==metadata.name||manifest.version!==metadata.version)throw Error('Sealed npm manifest differs');
  return metadata;
}
function gh(...args) { return execFileSync('gh', args, { encoding: 'utf8', timeout: 120000, maxBuffer:16*1024*1024 }).trim(); }
export function validateTag(metadata) {
  const output = gh('api', `repos/${metadata.repository}/git/ref/tags/${encodeURIComponent(metadata.tag)}`);
  let object = JSON.parse(output).object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) object = JSON.parse(gh('api', `repos/${metadata.repository}/git/tags/${object.sha}`)).object;
  if (object.type !== 'commit' || object.sha !== metadata.candidate_sha) throw Error('Existing release tag does not point to sealed candidate');
}
function findRelease(repository,tag) {
  const pages=JSON.parse(gh('api',`repos/${repository}/releases`,'--paginate','--slurp'));
  if(!Array.isArray(pages)||pages.some(page=>!Array.isArray(page)))throw Error('Release listing was not a valid paginated response');
  const releases=pages.flat();
  if(releases.some(release=>!release||typeof release.tag_name!=='string'))throw Error('Release listing contains unverifiable identities');
  const matches=releases.filter(release=>release.tag_name===tag);
  if(matches.length>1)throw Error('Ambiguous existing GitHub Release identity');
  return matches[0]||null;
}
export function reconcileGitHub(metadata, notes, input = 'release-sealed') {
  let release=findRelease(metadata.repository,metadata.tag);
  if(!release){
    writeFileSync(join(input,'notes.md'),notes);
    gh('release','create',metadata.tag,'--repo',metadata.repository,'--verify-tag','--latest=false','--title',metadata.tag,'--notes-file',join(input,'notes.md'));
    release=findRelease(metadata.repository,metadata.tag);
    if(!release)throw Error('Created GitHub Release could not be read back');
  }
  if(!Array.isArray(release.assets))throw Error('Release assets could not be verified');
  if (release.tag_name !== metadata.tag) throw Error('Unexpected existing GitHub Release identity');
  if(release.body !== notes || release.prerelease) throw Error('Existing GitHub Release notes or channel differ from original');
  for (const name of ['final.tgz', 'final.json']) {
    const asset = release.assets.find(item => item.name === name);
    if (asset) {
      const temp = mkdtempSync(join(tmpdir(), 'release-asset-'));
      try {
        gh('release', 'download', metadata.tag, '--repo', metadata.repository, '--pattern', name, '--dir', temp);
        if (sha256(join(temp, name)) !== sha256(join(input, name))) throw Error(`Existing GitHub asset differs: ${name}`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    } else gh('release', 'upload', metadata.tag, join(input, name), '--repo', metadata.repository);
  }
  if (release.draft) gh('release', 'edit', metadata.tag, '--repo', metadata.repository, '--draft=false');
  const observed = findRelease(metadata.repository,metadata.tag);
  if (!observed || observed.draft || observed.tag_name !== metadata.tag) throw Error('GitHub Release publication was not verified');
  for (const name of ['final.tgz', 'final.json']) {
    const matches = observed.assets.filter(asset => asset.name === name);
    if (matches.length !== 1) throw Error(`GitHub asset is missing or ambiguous: ${name}`);
    if (matches[0].digest) {
      if (matches[0].digest !== `sha256:${sha256(join(input, name))}`) throw Error(`Published GitHub asset digest mismatch: ${name}`);
    } else {
      const temp = mkdtempSync(join(tmpdir(), 'release-readback-'));
      try {
        gh('release', 'download', metadata.tag, '--repo', metadata.repository, '--pattern', name, '--dir', temp);
        if (sha256(join(temp, name)) !== sha256(join(input, name))) throw Error(`Published GitHub asset differs: ${name}`);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
  mkdirSync(join(input, 'receipts'), { recursive: true });
  writeFileSync(join(input, 'receipts/github-release.json'), JSON.stringify({ status: 'completed', candidate_sha:metadata.candidate_sha,version:metadata.version,observed_at:new Date().toISOString(),remote_id:String(observed.id),url: observed.html_url, sha256: metadata.sha256 }));
}
export function selectRecoveryEntries(entries) {
  if (new Set(entries).size !== entries.length || entries.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw Error('Unsafe or duplicate recovery archive entry');
  const selected = {};
  for (const name of ['final.json', 'final.tgz']) {
    const matches = entries.filter(entry => entry === name || entry === `release-sealed/${name}`);
    if (matches.length !== 1) throw Error(`Recovery requires exactly one sealed ${name}`);
    selected[name] = matches[0];
  }
  const roots = new Set(Object.values(selected).map(entry => entry.includes('/') ? 'release-sealed' : ''));
  if (roots.size !== 1) throw Error('Ambiguous recovery payload root');
  return selected;
}
export async function recover() {
  if (process.env.RELEASE_ENABLED !== 'true') throw Error('Publication remains disabled');
  const repository = process.env.GITHUB_REPOSITORY;
  const sourceRunId = process.env.SOURCE_RUN_ID, artifactId = process.env.ARTIFACT_ID;
  if (!/^\d+$/.test(sourceRunId || '') || !/^\d+$/.test(artifactId || '')) throw Error('Recovery requires source_run_id and artifact_id');
  const run = JSON.parse(gh('api', `repos/${repository}/actions/runs/${sourceRunId}`));
  const artifact = JSON.parse(gh('api', `repos/${repository}/actions/artifacts/${artifactId}`));
  const source = verifyRecoverySource({ run, artifact, repository, sourceRunId, artifactId });
  if (!String(artifact.name || '').startsWith(`release-receipts-${source.candidate_sha}-`)) throw Error('Recovery requires a sealed release-receipts artifact');
  // Download by immutable artifact ID, never by mutable artifact name.
  const archive = execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifactId}/zip`], { timeout: 120000, maxBuffer: 100 * 1024 * 1024 });
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') || artifact.digest !== 'sha256:' + createHash('sha256').update(archive).digest('hex')) throw Error('Original artifact download digest mismatch or unavailable');
  writeFileSync('recovery.zip', archive);
  const entries = execFileSync('unzip', ['-Z1', 'recovery.zip'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const selected = selectRecoveryEntries(entries);
  const input = 'recovery-source';
  mkdirSync(input, { recursive: true });
  // Read only allowlisted ZIP members into controlled filenames. Never extract
  // directories or symlinks from an artifact into the runner filesystem.
  for (const [name, entry] of Object.entries(selected)) {
    const bytes = execFileSync('unzip', ['-p', 'recovery.zip', entry], { maxBuffer: 100 * 1024 * 1024 });
    writeFileSync(join(input, name), bytes);
  }
  const metadata = JSON.parse(readFileSync(join(input, 'final.json')));
  validatePayload(metadata, join(input, 'final.tgz'));
  if (metadata.operation !== 'release') throw Error('Recovery must reference the original release payload');
  if (metadata.candidate_sha !== source.candidate_sha || metadata.repository !== repository || String(metadata.source_run_id) !== String(sourceRunId)) throw Error('Original payload provenance mismatch');
  validateTag(metadata);
  mkdirSync('release-sealed', { recursive: true });
  for (const name of ['final.json', 'final.tgz']) writeFileSync(join('release-sealed', name), readFileSync(join(input, name)));
  writeFileSync('release-sealed/recovery.json', JSON.stringify(source));
  process.env.CANDIDATE_SHA = metadata.candidate_sha;
  await verifyNpm({recover:true});
  reconcileGitHub(metadata, metadata.notes);
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) await recover();
