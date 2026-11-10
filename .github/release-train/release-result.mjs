// A release observation is independent of whether publication is enabled.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {withPipelineResult} from './pipeline-contract.mjs';

export const supportedPipelineProtocols = Object.freeze([1]);

const verificationStates = new Set(['passed', 'failed', 'not-run']);
const targetStates = new Set(['completed', 'failed', 'in-progress', 'not-run', 'unknown']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function pipelineMetadata(value, intended) {
  if (value === undefined) return undefined;
  if (!object(value) || value.protocol_version !== 1) throw new Error('Unsupported pipeline result protocol');
  if (!Array.isArray(value.goals) || value.goals.length !== intended.length ||
      value.goals.some(goal => !object(goal) || typeof goal.id !== 'string' || !intended.includes(goal.id) || typeof goal.asynchronous !== 'boolean' || !['supported', 'unsupported'].includes(goal.recovery)) ||
      new Set(value.goals.map(goal => goal.id)).size !== intended.length) {
    throw new Error('Pipeline goals must declare every intended target exactly once with asynchronous and recovery capabilities');
  }
  if (value.stage_observations !== undefined && (!object(value.stage_observations) || Object.values(value.stage_observations).some(observation => !object(observation) || !targetStates.has(observation.status)))) {
    throw new Error('Invalid pipeline stage observations');
  }
  return structuredClone(value);
}

function presentationMetadata(value, intended) {
  if (value === undefined) return undefined;
  if (!object(value) || !Array.isArray(value.milestones)) throw new Error('Invalid presentation milestones');
  for (const milestone of value.milestones) {
    if (!object(milestone)) throw new Error('Invalid presentation milestone');
    const references = [...(Array.isArray(milestone.requires) ? milestone.requires : []), ...(Array.isArray(milestone.outstanding) ? milestone.outstanding : [])];
    if (!Array.isArray(milestone.requires) || !milestone.requires.length || !Array.isArray(milestone.outstanding) || !milestone.outstanding.length ||
        references.some(id => !intended.includes(id)) || new Set(references).size !== references.length ||
        ['completed_label', 'pending_label', 'next', 'recovery_scope'].some(key => typeof milestone[key] !== 'string' || !milestone[key].trim())) {
      throw new Error('Presentation milestones require declared target IDs and nonempty labels, next action and recovery scope');
    }
  }
  return structuredClone(value);
}

const pipelineFailed = pipeline => Object.values(pipeline?.stage_observations ?? {}).some(observation => observation.status === 'failed');
const pendingGoals = (pipeline, targets) => pipeline.goals.every(goal => targets[goal.id]?.status === 'completed' || (goal.asynchronous && targets[goal.id]?.status === 'in-progress'));

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
  const pipeline = pipelineMetadata(input.pipeline, intended);
  const presentation = presentationMetadata(input.presentation, intended);
  for (const name of intended) targets[name] ??= { status: 'unknown', reason: 'No remote receipt was supplied' };
  for (const target of Object.values(targets)) {
    if(pipeline&&target.status==='in-progress'&&!(target.candidate_sha===input.candidate_sha&&target.version===version&&typeof target.observed_at==='string'&&Number.isFinite(Date.parse(target.observed_at))&&(target.remote_id||target.url))) {
      target.status='unknown';
      target.reason='External processing has not been confirmed for this exact release';
    }
    if (target.status === 'completed' && (input.schema_version === 1 || !(target.candidate_sha === input.candidate_sha && target.version === version && typeof target.observed_at === 'string' && Number.isFinite(Date.parse(target.observed_at)) && (target.remote_id || target.url)))) {
      target.status = 'unknown';
      target.reason = 'Legacy or incomplete receipt does not establish remote publication';
    }
  }
  const states = intended.map(name => targets[name].status);
  const completed = states.filter(state => state === 'completed').length;
  const failed = input.analysis === 'failed' || verification === 'failed' || states.includes('failed') || Boolean(input.failure_stage) || pipelineFailed(pipeline);
  const pending = pipeline ? verification === 'passed' && !failed && pendingGoals(pipeline, targets) : input.asynchronous === true;
  let publication;
  if (!input.enabled) publication = 'disabled';
  else if (completed && (failed || verification !== 'passed' || completed !== states.length)) publication = 'partial';
  else if (failed) publication = 'failed';
  else if (verification !== 'passed') publication = input.concluded === true && !pending ? 'failed' : 'in-progress';
  else if (version === null && ['success','no-release'].includes(input.analysis)) publication = 'no-release';
  else if (intended.every(name => targets[name].status === 'completed')) publication = 'completed';
  else if (input.concluded === true && !pending) publication = 'failed';
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
    ...(pipeline === undefined ? {} : {pipeline}),
    ...(presentation === undefined ? {} : {presentation}),
  };
}

export function reportExitCode(result) {
  if(!result||result.schema_version!==2)return 0;
  if (result.pipeline !== undefined) {
    const pipeline = pipelineMetadata(result.pipeline, result.intended_targets);
    if (result.analysis === 'failed' || result.verification === 'failed' || result.failure_stage || pipelineFailed(pipeline) || result.intended_targets.some(name => result.targets[name]?.status === 'failed')) return 1;
    if (['disabled', 'no-release', 'completed'].includes(result.publication)) return 0;
    return result.verification === 'passed' && pendingGoals(pipeline, result.targets) ? 0 : 1;
  }
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
export function writeResult(outputPath, input, { summaryPath = process.env.GITHUB_STEP_SUMMARY, config, plan } = {}) {
  const result = createResult(config||plan?withPipelineResult(input,{config,plan}):input);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  if (summaryPath) {
    const labels = {completed:'Publication complete',partial:'Publication incomplete',failed:'Publication not confirmed','in-progress':'Publication in progress','no-release':'No release needed',disabled:result.verification==='failed'?'Validation failed · Publication disabled':result.failure_stage?'Outcome not confirmed · Publication disabled':result.verification!=='passed'?'Checks not confirmed · Publication disabled':result.version===null&&['success','no-release'].includes(result.analysis)?'No release needed · Publication disabled':'Checks passed · Publication disabled'};
    const rows = Object.entries(result.targets).map(([name,target])=>`| ${cell(name)} | ${cell(target.status==='unknown'?'Not confirmed':target.status)} | ${cell(target.url || target.remote_id || target.reason)} |`);
    const recovery = result.recovery;
    const milestone = result.enabled && result.verification === 'passed' && !result.failure_stage && result.analysis !== 'failed' && !pipelineFailed(result.pipeline) ? result.presentation?.milestones.find(item => item.requires.every(id => result.targets[id]?.status === 'completed') && item.outstanding.some(id => result.targets[id]?.status !== 'completed') && result.intended_targets.every(id => result.targets[id]?.status !== 'failed' || item.outstanding.includes(id))) : undefined;
    const outstanding = milestone?.outstanding.map(id => result.targets[id]).filter(target => target?.status !== 'completed') ?? [];
    const pendingLabel = outstanding.some(target => target?.status === 'failed') ? 'failed' : outstanding.every(target => target?.status === 'in-progress') ? 'pending' : 'not confirmed';
    const headline = milestone ? `${cell(milestone.completed_label)} · ${cell(milestone.pending_label)} ${pendingLabel}` : labels[result.publication];
    const noAction=['completed','no-release'].includes(result.publication);
    const showRecovery=!noAction&&result.publication!=='disabled';
    const action = noAction?'No action needed.':result.verification==='failed'&&result.publication==='disabled'?'Correct the failed verification and validate a fresh candidate. Publication remains disabled.':result.publication==='disabled'&&result.failure_stage?'Inspect the failed report stage and restore its original evidence. Publication remains disabled.':milestone?cell(milestone.next):showRecovery&&recovery.available?(recovery.command ? cell(recovery.command) : 'Inspect the original evidence and supported recovery entrypoint before recovery.'):result.publication==='disabled'?'No publication was attempted. Initial activation remains separate.':'Inspect the failed stage and remote receipts before starting another release.';
    const lines = [`## ${headline}`,'',`Next: ${action}`,'',`Version: ${cell(result.version)||'none'} · Candidate: \`${result.candidate_sha.slice(0,7)}\` · Observed: ${cell(result.observed_at)}`,'',`Analysis: ${cell(result.analysis)}; verification: ${cell(result.verification)}; publication enabled: ${result.enabled}`,'','| Target | Result | Evidence |','| --- | --- | --- |',...rows,''];
    if(result.failure_stage)lines.push(`Failed stage: ${cell(result.failure_stage)}`,'');
    for(const error of result.errors)lines.push(`- ${cell(typeof error==='string'?error:error.message??error.code)}`);
    if(showRecovery&&!recovery.available){
      lines.push('',`Recovery unavailable: ${cell(recovery.blocked_reason)}`);
      if(/^[1-9]\d*$/.test(String(recovery.source_run_id||''))&&/^[1-9]\d*$/.test(String(recovery.artifact_id||'')))lines.push(`Original run: ${cell(recovery.source_run_id)}; artifact: ${cell(recovery.artifact_id)}`);
    }
    else if(showRecovery)lines.push('',milestone?`Recovery scope: ${cell(milestone.recovery_scope)}`:`Recovery: ${recovery.command ? cell(recovery.command) : action}`,`Original run: ${cell(recovery.source_run_id)}; artifact: ${cell(recovery.artifact_id)}; source attempt: ${cell(recovery.source_attempt)}; expires: ${cell(recovery.expires_at)}`);
    if(showRecovery&&recovery.available&&recovery.wait_for_run_completion)lines.push('', 'Recovery prerequisite: Start recovery only after the original run has completed.');
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
