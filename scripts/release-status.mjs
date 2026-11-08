import {sealedTagFormat} from '../.github/release-train/npm-channel.mjs';
// Product-specific observations. Only channel readback can confirm publication.
import {createHash} from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import {receiptObservation} from './release-receipt.mjs';
import { writeResult } from '../.github/release-train/release-result.mjs';
const read = file => existsSync(file) ? JSON.parse(readFileSync(file)) : null;
const analysis = read('release-input/analysis.json') || read('release-plan.json') || read('release-analysis.json') || {};
const metadata = read('release-input/final.json') || {};
const enabled = process.env.RELEASE_ENABLED === 'true';
const operation = process.argv[2];
const intended = read('.github/release-train.json')?.intended_targets || ['npm','github-packages','github-release',...(process.env.RELEASE_HOMEBREW === 'true' ? ['homebrew'] : [])];
let verification = 'not-run';
if (operation === 'verify') verification = process.env.ANALYSIS_OUTCOME === 'success' && (!analysis.version || (process.env.VERIFY_OUTCOME === 'success' && process.env.PACKAGE_OUTCOME === 'success')) ? 'passed' : 'failed';
else if (operation === 'publish') verification = process.env.RESTORE_OUTCOME === 'success' ? 'passed' : 'failed';
else if (operation === 'recover') verification = existsSync('release-input/recovery.json') ? 'passed' : 'failed';
const candidate = metadata.candidate_sha || analysis.candidate_sha || process.env.GITHUB_SHA;
const version = metadata.version || analysis.version || null;
const targets = {};
for (const target of intended) {
 const receipt = read(`release-input/receipts/${target}.json`);
 targets[target]=receiptObservation(receipt,{candidate_sha:candidate,version,sha256:metadata.sha256},target);
}
const failed = verification === 'failed' || process.env.PUBLISH_OUTCOME === 'failure';
const recovery=read('release-input/recovery.json') || (operation==='recover'&&(process.env.SOURCE_RUN_ID||process.env.ARTIFACT_ID)?{source_run_id:process.env.SOURCE_RUN_ID||null,artifact_id:process.env.ARTIFACT_ID||null,available:false,identity_verified:false,blocked_reason:'Original dispatch identities have not been verified'}:null);
const inputErrors = [];
let sealed = null;
try {
sealed = (process.env.SEALED_ARTIFACT_ID || recovery?.artifact_id) && metadata.sha256 ? {artifact_id:process.env.SEALED_ARTIFACT_ID || recovery?.artifact_id,source_run_id:metadata.source_run_id,source_attempt:metadata.source_attempt || process.env.GITHUB_RUN_ATTEMPT,candidate_sha:candidate,tag:metadata.tag,tag_format:sealedTagFormat({...metadata,tag_format:metadata.tag_format??analysis.tag_format}),repository:metadata.repository,sha256:metadata.sha256,notes:analysis.notes,expected_assets:Object.fromEntries(['final.tgz','final.json'].map(name=>[name,'sha256:'+createHash('sha256').update(readFileSync(`release-input/${name}`)).digest('hex')]))} : null;
} catch (error) {
 verification = 'failed';
 inputErrors.push({message: `Original sealed tag/artifact input is invalid: ${error.message}`});
}
writeResult('release-result.json',{schema_version:2,analysis:analysis.candidate_sha ? (version ? 'success' : 'no-release') : 'unknown',candidate_sha:candidate,baseline_tag:analysis.baseline_tag || null,version,enabled,verification,intended_targets:intended,concluded:true,targets,artifacts:sealed?[sealed]:[],failure_stage:inputErrors.length?'report-inputs':failed?operation:null,recovery,errors:[...inputErrors,...(failed?[{message:process.env.RETRY_GUARD_OUTCOME === 'failure' ? `Analysis retry stopped because prior writes may have created a baseline tag. Read the original Release outcome at ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/1; recover its original sealed release, or start a new manual release run for fresh main.` : `${operation} failed; inspect the failing Actions step`}]:[])]},{summaryPath:null});
