// A release observation is independent of whether publication is enabled.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const verificationStates = new Set(['passed', 'failed', 'not-run']);
const targetStates = new Set(['completed', 'failed', 'in-progress', 'not-run', 'unknown']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createResult(input) {
  if (!object(input) || !/^[a-f0-9]{40}$/.test(input.candidate_sha || '')) {
    throw new Error('An exact release candidate SHA is required');
  }
  if (input.schema_version !== undefined && ![1, 2].includes(input.schema_version)) throw new Error('Unsupported result schema');
  if (typeof input.enabled !== 'boolean') throw new Error('Publication enabled must be a boolean');
  const verification = input.verification ?? 'not-run';
  if (!verificationStates.has(verification)) throw new Error('Invalid verification state');
  const targets = structuredClone(input.targets ?? {});
  if (!object(targets) || Object.values(targets).some(target => !object(target) || !targetStates.has(target.status))) {
    throw new Error('Each publication target needs an explicit supported state');
  }
  const version = input.version ?? null;
  if (version !== null && (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))) {
    throw new Error('Invalid analyzed release version');
  }
  const observedAt = input.observed_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid observation timestamp');
  const intended = input.intended_targets;
  if (!Array.isArray(intended) || !intended.length || intended.some(name => typeof name !== 'string' || !name) || new Set(intended).size !== intended.length) throw new Error('Explicit intended publication targets are required');
  for (const name of intended) targets[name] ??= { status: 'unknown', reason: 'No remote receipt was supplied' };
  for (const target of Object.values(targets)) {
    if (target.status === 'completed' && (input.schema_version === 1 || !(target.candidate_sha === input.candidate_sha && target.version === version && typeof target.observed_at === 'string' && Number.isFinite(Date.parse(target.observed_at)) && (target.remote_id || target.url)))) {
      target.status = 'unknown';
      target.reason = 'Legacy or incomplete receipt does not establish remote publication';
    }
  }
  const states = intended.map(name => targets[name].status);
  const completed = states.filter(state => state === 'completed').length;
  const failed = input.analysis === 'failed' || verification === 'failed' || states.includes('failed') || Boolean(input.failure_stage);
  let publication;
  if (!input.enabled) publication = 'disabled';
  else if (completed && (failed || verification !== 'passed' || completed !== states.length)) publication = 'partial';
  else if (failed) publication = 'failed';
  else if (verification !== 'passed') publication = input.concluded === true && input.asynchronous !== true ? 'failed' : 'in-progress';
  else if (version === null && ['success','no-release'].includes(input.analysis)) publication = 'no-release';
  else if (intended.every(name => targets[name].status === 'completed')) publication = 'completed';
  else if (input.concluded === true && input.asynchronous !== true) publication = 'failed';
  else publication = 'in-progress';
  if (input.publication !== undefined && input.publication !== publication) {
    throw new Error('Publication state conflicts with observed verification or target results');
  }
  if (input.artifacts !== undefined && !Array.isArray(input.artifacts)) throw new Error('Artifacts must be an array');
  if (input.errors !== undefined && !Array.isArray(input.errors)) throw new Error('Errors must be an array');
  return {
    schema_version: 2,
    observed_at: observedAt,
    intended_targets: [...intended],
    analysis: input.analysis ?? 'unknown',
    asynchronous: input.asynchronous === true,
    concluded: input.concluded === true,
    candidate_sha: input.candidate_sha,
    baseline_tag: input.baseline_tag ?? null,
    version,
    enabled: input.enabled,
    verification,
    publication,
    targets: structuredClone(targets),
    artifacts: structuredClone(input.artifacts ?? []),
    failure_stage: input.failure_stage ?? null,
    recovery: recoveryMetadata(input.recovery),
    errors: structuredClone(input.errors ?? []),
  };
}

export function reportExitCode(result) {
  if(!result||result.schema_version!==2)return 0;
  return result.verification==='failed'||Boolean(result.failure_stage)||result.intended_targets.some(name=>result.targets[name]?.status==='failed')||result.publication==='failed'||(result.publication==='partial'&&!result.asynchronous)?1:0;
}

export function recoveryMetadata(value) {
  if (!value) return {available:false, blocked_reason:'Original sealed artifact identity is unavailable'};
  const required = ['source_run_id','artifact_id','digest','source_attempt','expires_at'];
  const valid = value.available === true && value.tag_verified === true && required.every(key => value[key]) && /^[1-9]\d*$/.test(String(value.source_run_id)) && /^[1-9]\d*$/.test(String(value.artifact_id)) && /^sha256:[a-f0-9]{64}$/.test(value.digest) && Number.isFinite(Date.parse(value.expires_at)) && Date.parse(value.expires_at)>Date.now();
  const metadata=structuredClone(value);if(!valid)delete metadata.command;
  return {...metadata, available:valid, blocked_reason:valid?null:(value.blocked_reason || 'Recovery requires a verified original tag and unexpired immutable producer metadata')};
}
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ');
export function writeResult(outputPath, input, { summaryPath = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const result = createResult(input);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  if (summaryPath) {
    const labels = {completed:'Publication complete',partial:'Publication incomplete',failed:'Publication not confirmed','in-progress':'Publication in progress','no-release':'No release needed',disabled:result.verification==='failed'?'Validation failed · Publication disabled':result.failure_stage?'Outcome not confirmed · Publication disabled':result.verification!=='passed'?'Checks not confirmed · Publication disabled':result.version===null&&['success','no-release'].includes(result.analysis)?'No release needed · Publication disabled':'Checks passed · Publication disabled'};
    const rows = Object.entries(result.targets).map(([name,target])=>`| ${cell(name)} | ${cell(target.status==='unknown'?'Not confirmed':target.status)} | ${cell(target.url || target.remote_id || target.reason)} |`);
    const recovery = result.recovery;
    const outstandingNative=result.intended_targets.filter(name=>/(^|_)(cloud|archive|asc_upload|testflight)(_|$)/.test(name)&&result.targets[name]?.status!=='completed').map(name=>result.targets[name]);
    const nativePending=result.verification==='passed'&&result.targets.github?.status==='completed'&&outstandingNative.length>0;
    const nativeLabel=outstandingNative.some(target=>target?.status==='failed')?'failed':outstandingNative.every(target=>target?.status==='in-progress')?'pending':'not confirmed';
    const headline=nativePending?`GitHub publication complete · TestFlight ${nativeLabel}`:labels[result.publication];
    const noAction=['completed','no-release'].includes(result.publication);
    const showRecovery=!noAction&&result.publication!=='disabled';
    const action = noAction?'No action needed.':result.verification==='failed'&&result.publication==='disabled'?'Correct the failed verification and validate a fresh candidate. Publication remains disabled.':result.publication==='disabled'&&result.failure_stage?'Inspect the failed report stage and restore its original evidence. Publication remains disabled.':nativePending?'Inspect the native Cloud and TestFlight evidence links for outstanding delivery stages.':showRecovery&&recovery.available?(recovery.command || `gh workflow run release.yml --ref main -f operation=recover -f source_run_id=${recovery.source_run_id} -f artifact_id=${recovery.artifact_id}`):result.publication==='disabled'?'No publication was attempted. Initial activation remains separate.':'Inspect the failed stage and remote receipts before starting another release.';
    const lines = [`## ${headline}`,'',`Next: ${showRecovery&&recovery.available&&recovery.wait_for_run_completion?'After the original run completes: ':''}${action}`,'',`Version: ${cell(result.version)||'none'} · Candidate: \`${result.candidate_sha.slice(0,7)}\` · Observed: ${cell(result.observed_at)}`,'',`Analysis: ${cell(result.analysis)}; verification: ${cell(result.verification)}; publication enabled: ${result.enabled}`,'','| Target | Result | Evidence |','| --- | --- | --- |',...rows,''];
    if(result.failure_stage)lines.push(`Failed stage: ${cell(result.failure_stage)}`,'');
    for(const error of result.errors)lines.push(`- ${cell(typeof error==='string'?error:error.message??error.code)}`);
    if(showRecovery&&!recovery.available)lines.push('',`Recovery unavailable: ${cell(recovery.blocked_reason)}`);
    else if(showRecovery)lines.push('',nativePending?'Recovery scope: GitHub only.':`Recovery: ${recovery.command || action}`,`Original run: ${cell(recovery.source_run_id)}; artifact: ${cell(recovery.artifact_id)}; source attempt: ${cell(recovery.source_attempt)}; expires: ${cell(recovery.expires_at)}`);
    lines.push('','<details><summary>Technical evidence</summary>','','```json',JSON.stringify(result,null,2),'```','','</details>');
    appendFileSync(summaryPath,lines.join('\n')+'\n');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const input = value('--input');
  const output = value('--output');
  if (!input || !output || args.length !== 4) throw new Error('Usage: release-result.mjs --input INPUT.json --output release-result.json');
  writeResult(output, JSON.parse(readFileSync(input, 'utf8')));
}
