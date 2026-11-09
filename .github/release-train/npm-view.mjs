import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
// npm 12 wraps single-field results in an array; npm 11 returns the value.
// A single exact query must never choose between multiple observations.
export function parseNpmView(stdout) {
  const value = JSON.parse(stdout);
  if (!Array.isArray(value)) return value;
  if (value.length !== 1 || Array.isArray(value[0])) {
    throw Error('Ambiguous npm view response: expected a single observation');
  }
  return value[0];
}

// One deadline covers immutable bytes and channel convergence across registries.
// Returning null means a validated observation is still pending, never a read error.
export function createNpmObservationBudget({timeoutMs = 900000, intervalMs = 15000, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('Invalid npm observation budget');
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(0, Math.floor(deadline - now()));
  const pending = () => Object.assign(Error('npm registry observation is not confirmed within the shared observation budget; preserve the original receipt and artifact'), {code: 'NPM_AVAILABILITY_PENDING'});
  const assertRemaining = () => {const available = remaining(); if (!available) throw pending(); return available;};
  return {remaining, assertRemaining, async wait(read) {
    for (;;) {
      const value = await read(assertRemaining());
      if (value !== null) return value;
      const available = assertRemaining();
      await sleep(Math.min(intervalMs, available));
    }
  }};
}

// Absence of evidence is not proof that an asynchronous request was never sent.
export function npmRequestState(metadata, receipt) {
 if (receipt === undefined) return 'unconfirmed';
 if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.candidate_sha !== metadata.candidate_sha || receipt.version !== metadata.version
     || (receipt.sha256 === undefined && receipt.integrity === undefined)
     || (receipt.sha256 !== undefined && receipt.sha256 !== metadata.sha256)
     || (receipt.integrity !== undefined && receipt.integrity !== metadata.integrity)
     || (receipt.source_run_id !== undefined && String(receipt.source_run_id) !== String(metadata.source_run_id))) throw Error('Registry request receipt differs from original identity or bytes');
 if (receipt.status === 'not-run' && receipt.request_started_at === undefined && receipt.publication_accepted === undefined && receipt.accepted_at === undefined) return 'unsent';
 return 'observe';
}

export function parseNpmIntegrity(result, expected, target = 'npm') {
 if (result.error) throw result.error;
 let value;
 try {value = parseNpmView(result.stdout);}
 catch (cause) {throw new Error(`${target}: registry integrity response could not be interpreted: ${result.status ? result.stderr || cause.message : cause.message}`, {cause});}
 if (result.status !== 0) {
  if (value?.error?.code === 'E404') return null;
  throw Error(`${target}: registry lookup failed: ${result.stderr || result.stdout}`);
 }
 if (value !== expected) throw Error(`${target}: existing version differs from sealed original bytes`);
 return true;
}

// Native immutable Actions artifacts keep an earlier recovery's uncertain request
// from being authorized again by the original run's unchanged not-run receipt.
export function allowRecoveryRequest({env = process.env, timeout = 120000, read = path => JSON.parse(execFileSync('gh', ['api', path, '--paginate', '--slurp'], {env, encoding:'utf8', timeout:Math.min(120000,timeout)}))} = {}) {
 for (const key of ['GITHUB_RUN_ID','SOURCE_RUN_ID','ARTIFACT_ID','RECOVERY_INTENT_ARTIFACT_ID']) if (!/^[1-9]\d*$/.test(String(env[key] || ''))) throw Error('Original recovery request intent identity is missing');
 if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw Error('Recovery request intent repository is missing');
 const name=`release-recovery-intent-${env.SOURCE_RUN_ID}-${env.ARTIFACT_ID}`;
 const pages=read(`repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=${name}&per_page=100`);
 if (!Array.isArray(pages) || !pages.length || pages.some(page=>!Array.isArray(page.artifacts))) throw Error('Recovery request intent listing is unverifiable');
 const artifacts=pages.flatMap(page=>page.artifacts);
 if (artifacts.some(item=>!item || item.name!==name || !/^[1-9]\d*$/.test(String(item.id)) || !/^[1-9]\d*$/.test(String(item.workflow_run?.id)))) throw Error('Recovery request intent listing contains invalid identities');
 const matches=artifacts.filter(item=>String(item.id)===env.RECOVERY_INTENT_ARTIFACT_ID);
 if (matches.length!==1 || matches[0].expired!==false || String(matches[0].workflow_run.id)!==env.GITHUB_RUN_ID) throw Error('Current immutable recovery request intent is missing or foreign');
 return artifacts.length===1;
}
