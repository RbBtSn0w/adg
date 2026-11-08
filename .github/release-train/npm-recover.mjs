// Recovery uses current trusted workflow code and the original sealed publication bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRecovery,observeNpmGitHub,validateRecoveryPayload} from './npm-recovery-source.mjs';
export {inspectRecovery,selectRecoveryEntries} from './npm-recovery-source.mjs';
import { verifyNpm } from './npm-release-adapter.mjs';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export const validatePayload=validateRecoveryPayload;
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
  rmSync(join(input,'receipts/github-release.json'),{force:true});
  if(notes!==metadata.notes)throw Error('GitHub reconciliation requires original sealed notes');
  const preflight=observeNpmGitHub({plan:metadata,inputDirectory:input});
  if(preflight.recovery.state!=='repairable')throw Error(`GitHub recovery preflight blocked: ${preflight.recovery.reason}`);
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
  if (release.draft) gh('release', 'edit', metadata.tag, '--repo', metadata.repository, '--latest=false', '--draft=false');
  const observed = findRelease(metadata.repository,metadata.tag);
  if(!observed||String(observed.id)!==String(release.id)||observed.draft!==false||observed.prerelease!==false||observed.tag_name!==metadata.tag||observed.body!==metadata.notes)throw Error('GitHub Release final readback differs from original identity, notes or stable channel');
  if(!Array.isArray(observed.assets))throw Error('GitHub Release final asset readback is unavailable');
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
export async function recover() {
  if (process.env.RELEASE_ENABLED !== 'true') throw Error('Publication remains disabled');
  const {metadata,files,source,publicationObservation}=inspectRecovery();
  if(publicationObservation.recovery.state!=='repairable')throw Error(`GitHub recovery preflight blocked: ${publicationObservation.recovery.reason}`);
  mkdirSync('release-sealed', { recursive: true });
  for (const name of ['final.json', 'final.tgz']) writeFileSync(join('release-sealed', name), files[name]);
  writeFileSync('release-sealed/recovery.json', JSON.stringify(source));
  process.env.CANDIDATE_SHA = metadata.candidate_sha;
  let channelError;
  try{await verifyNpm({recover:true});}
  catch(error){
    const receipt=error.publicationReceipt;
    if(receipt?.status!=='unknown'||receipt.bytes_verified!==true||receipt.channel_blocked!==true||receipt.candidate_sha!==metadata.candidate_sha||receipt.version!==metadata.version||receipt.sha256!==metadata.sha256)throw error;
    channelError=error;
  }
  reconcileGitHub(metadata, metadata.notes);
  if(channelError)throw channelError;
}
if (process.argv[1] && process.argv[1]!=='-' && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await recover();
