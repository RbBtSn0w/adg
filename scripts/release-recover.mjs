import {sealedTagFormat} from '../.github/release-train/npm-channel.mjs';
// Recovery uses current trusted workflow code and the original sealed publication bytes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import { verifyRecoverySource, verifyRecoveryArtifactRole } from '../.github/release-train/recovery-source.mjs';
import {observeRelease} from './release-observe.mjs';
import { publish } from './release-payload.mjs';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function validatePayload(metadata, analysis, archive) {
  if (sealedTagFormat({...metadata,tag_format:metadata.tag_format??analysis.tag_format}) !== sealedTagFormat(analysis)) throw Error('Sealed tag format mismatch');
  metadata.tag_format = sealedTagFormat(analysis);
  if (metadata.candidate_sha !== analysis.candidate_sha || metadata.version !== analysis.version || metadata.tag !== analysis.tag || metadata.sha256 !== sha256(archive)) throw Error('Sealed release payload mismatch');
  if (!/^[a-f0-9]{40}$/.test(metadata.candidate_sha) || !metadata.tag || !metadata.version || !metadata.repository || !metadata.source_run_id) throw Error('Incomplete sealed release identity');
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
  if (metadata.integrity !== integrity) throw Error('Sealed registry integrity mismatch');
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  if (manifest.version !== metadata.version || manifest.name !== metadata.name) throw Error('Sealed package manifest mismatch');
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
export function reconcileGitHub(metadata, notes, input = 'release-input') {
  rmSync(join(input,'receipts/github-release.json'),{force:true});
  validateTag(metadata);
  const observation=observeRelease({metadata,notes,input});
  if(observation.recovery.state!=='repairable')throw Error(`GitHub reconciliation blocked: ${observation.recovery.reason}`);
  let release=findRelease(metadata.repository,metadata.tag);
  if(!release){
    writeFileSync(join(input,'notes.md'),notes);
    gh('release','create',metadata.tag,'--repo',metadata.repository,'--verify-tag','--latest=false','--title',metadata.tag,'--notes-file',join(input,'notes.md'));
    release=findRelease(metadata.repository,metadata.tag);
    if(!release)throw Error('Created GitHub Release could not be read back');
  }
  if(!/^[1-9]\d*$/.test(String(release.id||'')))throw Error('GitHub Release identity could not be verified');
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
  if (release.draft) gh('release', 'edit', metadata.tag, '--repo', metadata.repository, '--draft=false', '--latest=false');
  const observed = findRelease(metadata.repository,metadata.tag);
  if (!observed || observed.draft !== false || observed.tag_name !== metadata.tag || observed.body !== notes || observed.prerelease !== false || String(observed.id) !== String(release.id)) throw Error('GitHub Release publication was not verified');
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
  writeFileSync(join(input, 'receipts/github-release.json'), JSON.stringify({ status: 'completed', candidate_sha: metadata.candidate_sha, version: metadata.version, observed_at: new Date().toISOString(), remote_id: observed.id ? String(observed.id) : observed.html_url, url: observed.html_url, sha256: metadata.sha256 }));
}
export function selectRecoveryEntries(entries) {
  if (new Set(entries).size !== entries.length || entries.some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw Error('Unsafe or duplicate recovery archive entry');
  const selected = {};
  for (const name of ['final.json', 'final.tgz', 'analysis.json']) {
    const matches = entries.filter(entry => entry === name || entry === `release-input/${name}`);
    if (matches.length !== 1) throw Error(`Recovery requires exactly one sealed ${name}`);
    selected[name] = matches[0];
  }
  const roots = new Set(Object.values(selected).map(entry => entry.includes('/') ? 'release-input' : ''));
  if (roots.size !== 1) throw Error('Ambiguous recovery payload root');
  return selected;
}
// Read the original sealed payload without publishing or altering the checkout.
export function inspectRecovery({repository=process.env.GITHUB_REPOSITORY,sourceRunId=process.env.SOURCE_RUN_ID,artifactId=process.env.ARTIFACT_ID}={}) {
  if (!/^[1-9]\d*$/.test(sourceRunId || '') || !/^[1-9]\d*$/.test(artifactId || '')) throw Error('Recovery requires original source_run_id and artifact_id');
  const run=JSON.parse(gh('api',`repos/${repository}/actions/runs/${sourceRunId}`));
  const artifact=JSON.parse(gh('api',`repos/${repository}/actions/artifacts/${artifactId}`));
  const source=verifyRecoverySource({run,artifact,repository,sourceRunId,artifactId});
  const sourceAttempt=verifyRecoveryArtifactRole({name:artifact.name,prefix:`release-receipts-${source.candidate_sha}`,runAttempt:run.run_attempt});
  const archive=execFileSync('gh',['api',`repos/${repository}/actions/artifacts/${artifactId}/zip`],{timeout:120000,maxBuffer:100*1024*1024});
  if(!/^sha256:[a-f0-9]{64}$/.test(artifact.digest||'')||artifact.digest!=='sha256:'+createHash('sha256').update(archive).digest('hex'))throw Error('Original artifact download digest mismatch or unavailable');
  const temporary=mkdtempSync(join(tmpdir(),'release-original-inspection-'));
  try{
    const zip=join(temporary,'original.zip');writeFileSync(zip,archive);
    const entries=execFileSync('unzip',['-Z1',zip],{encoding:'utf8'}).split('\n').filter(Boolean),selected=selectRecoveryEntries(entries);
    const input=join(temporary,'sealed');mkdirSync(input);
    const files=Object.fromEntries(Object.entries(selected).map(([name,entry])=>[name,execFileSync('unzip',['-p',zip,entry],{maxBuffer:100*1024*1024})]));
    for(const [name,bytes]of Object.entries(files))writeFileSync(join(input,name),bytes);
    const metadata=JSON.parse(files['final.json']),analysis=JSON.parse(files['analysis.json']);
    validatePayload(metadata,analysis,join(input,'final.tgz'));
    if(metadata.operation!=='release'||metadata.candidate_sha!==source.candidate_sha||metadata.repository!==repository||String(metadata.source_run_id)!==String(sourceRunId))throw Error('Original payload provenance mismatch');
    const publicationObservation=observeRelease({metadata,notes:analysis.notes,input});
    const expectedAssets=Object.fromEntries(['final.tgz','final.json'].map(name=>[name,'sha256:'+createHash('sha256').update(files[name]).digest('hex')]));
    return {source,sourceAttempt,run,artifact,metadata,analysis,files,publicationObservation,expectedAssets};
  }finally{rmSync(temporary,{recursive:true,force:true});}
}
export async function recover() {
  if(process.env.RELEASE_ENABLED!=='true')throw Error('Publication remains disabled');
  rmSync(join('release-input','receipts'),{recursive:true,force:true});
  const original=inspectRecovery();
  const {source,sourceAttempt,artifact,metadata,analysis,files,publicationObservation}=original;
  if(publicationObservation.recovery.state!=='repairable')throw Error(`Recovery blocked before registry writes: ${publicationObservation.recovery.reason}`);
  mkdirSync('release-input',{recursive:true});
  for(const [name,bytes]of Object.entries(files))writeFileSync(join('release-input',name),bytes);
  writeFileSync('release-input/recovery.json',JSON.stringify({...source,tag:metadata.tag,repository:metadata.repository,source_attempt:sourceAttempt,digest:artifact.digest,expires_at:artifact.expires_at}));
  process.env.CANDIDATE_SHA=metadata.candidate_sha;
  const publication=await publish({recovery:true,deferChannelErrors:true},{cwd:process.cwd(),env:process.env,nextRelease:{version:metadata.version}});
  const errors=[...(publication.deferred_errors||[])];
  try{reconcileGitHub(metadata,analysis.notes);}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Original recovery remains incomplete; inspect target receipts');
}
if(process.argv[1]&&process.argv[1]!=='-'&&realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(import.meta.url)))await recover();
