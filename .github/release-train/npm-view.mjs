import {appendFileSync} from 'node:fs';
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
export function allowRecoveryRequest({env = process.env, target='npm', preflight=false, timeout = 120000, read, readRun} = {}) {
 if(!['npm','github-packages'].includes(target))throw Error('Unknown registry recovery target');
 const deadline=performance.now()+timeout;
 const remaining=()=>{const value=Math.ceil(deadline-performance.now());if(!Number.isFinite(value)||value<=0)throw Object.assign(Error('Recovery intent observation budget expired'),{code:'NPM_AVAILABILITY_PENDING'});return Math.min(120000,value);};
 read??=path=>JSON.parse(execFileSync('gh',['api',path,'--paginate','--slurp'],{env,encoding:'utf8',timeout:remaining()}));
 readRun??=path=>JSON.parse(execFileSync('gh',['api',path],{env,encoding:'utf8',timeout:remaining()}));
 for(const key of ['GITHUB_RUN_ID','SOURCE_RUN_ID','ARTIFACT_ID'])if(!/^[1-9]\d*$/.test(String(env[key]||'')))throw Error('Original recovery request intent identity is missing');
 if(!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY||''))throw Error('Recovery request intent repository is missing');
 const currentId=env.RECOVERY_INTENT_ARTIFACT_ID||env[target==='npm'?'RECOVERY_INTENT_NPM_ID':'RECOVERY_INTENT_GITHUB_PACKAGES_ID'];
 const targetName=`release-recovery-intent-${env.SOURCE_RUN_ID}-${target}`;
 const legacyName=`release-recovery-intent-${env.SOURCE_RUN_ID}-${env.ARTIFACT_ID}`;
 let current=false;
 for(const name of [targetName,legacyName]){
  remaining();const pages=read(`repos/${env.GITHUB_REPOSITORY}/actions/artifacts?name=${name}&per_page=100`);
  if(!Array.isArray(pages)||!pages.length||pages.some(page=>!Array.isArray(page.artifacts)))throw Error('Recovery request intent listing is unverifiable');
  for(const artifact of pages.flatMap(page=>page.artifacts)){
   if(!artifact||artifact.name!==name||!/^[1-9]\d*$/.test(String(artifact.id))||!/^[1-9]\d*$/.test(String(artifact.workflow_run?.id)))throw Error('Recovery request intent listing contains invalid identities');
   if(name===targetName&&String(artifact.id)===String(currentId)){
    if(current||artifact.expired!==false||String(artifact.workflow_run.id)!==env.GITHUB_RUN_ID)throw Error('Current immutable recovery request intent is missing or foreign');
    current=true;continue;
   }
   remaining();const run=readRun(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${artifact.workflow_run.id}`);
   if(!run||String(run.id)!==String(artifact.workflow_run.id)||run.repository?.full_name?.toLowerCase()!==env.GITHUB_REPOSITORY.toLowerCase()||typeof run.path!=='string'||typeof run.head_branch!=='string'||typeof run.event!=='string')throw Error('Prior recovery intent provenance is unverifiable');
   if(run.path==='.github/workflows/release.yml'&&run.head_branch==='main'&&run.event==='workflow_dispatch')return false;
  }
 }
 if(preflight)return true;
 if(!/^[1-9]\d*$/.test(String(currentId||''))||!current)throw Error('Current immutable recovery request intent is missing or foreign');
 return true;
}

// GitHub steps in one job share a monotonic host clock, not a reset fifteen-minute
// allowance for each registry or a wall clock subject to adjustment.
export function startRecoveryObservationBudget(env=process.env){
 const deadline=(process.hrtime.bigint()+900000000000n).toString();
 env.RECOVERY_OBSERVATION_DEADLINE_NS=deadline;
 if(env.GITHUB_ENV)appendFileSync(env.GITHUB_ENV,`RECOVERY_OBSERVATION_DEADLINE_NS=${deadline}\n`);
 return recoveryObservationBudget(env);
}
export function recoveryObservationBudget(env=process.env){
 const value=env.RECOVERY_OBSERVATION_DEADLINE_NS;
 if(typeof value!=='string'||!/^[1-9]\d{0,24}$/.test(value))throw Error('Original recovery observation deadline is missing');
 const remaining=Number((BigInt(value)-process.hrtime.bigint())/1000000n);
 if(!Number.isFinite(remaining)||remaining<=0||remaining>900000)throw Object.assign(Error('Original recovery observation deadline expired or invalid'),{code:'NPM_AVAILABILITY_PENDING'});
 return createNpmObservationBudget({timeoutMs:remaining});
}

export function npmRequestFacts(metadata, receipt) {
 npmRequestState(metadata, receipt);
 return Object.fromEntries(['request_started_at','publication_accepted','accepted_at'].filter(key=>receipt?.[key]!==undefined).map(key=>[key,receipt[key]]));
}
