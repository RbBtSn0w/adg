import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {createPipelinePlan,normalizeConfig,validatePipelinePlan} from './pipeline-contract.mjs';

export function assertOperationCompatibility(adapter,config) {
  if (config.schema_version===2 && adapter.pipelineProtocolVersion!==config.protocol_version) throw Error('Release implementation is incompatible with the configured pipeline protocol');
}
function planPath(adapter,context) {
  if (typeof adapter.analysisFile!=='function') throw Error('Versioned release implementation must declare its analysis file');
  const root=realpathSync(context.cwd),path=realpathSync(resolve(root,adapter.analysisFile(context))),delta=relative(root,path);
  if (delta==='..'||delta.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(delta)) throw Error('Analysis file must remain inside repository');
  return path;
}
export function captureAnalysis(adapter,context) {
  if (context.config.schema_version!==2) return;
  const path=planPath(adapter,context),plan=JSON.parse(readFileSync(path,'utf8'));
  if (typeof adapter.planIdentity!=='function') throw Error('Versioned release implementation must expose its engine identity');
  const identity=adapter.planIdentity(plan,context);
  // A successful engine no-op has no issuance identity to recover.
  if (identity.version===null) return;
  const kind={schedule:'scheduled',workflow_dispatch:'manual'}[context.env.GITHUB_EVENT_NAME]||'unknown';
  const request={trigger_kind:kind,...(context.env.GITHUB_RUN_ID?{request_id:context.env.GITHUB_RUN_ID}:{})};
  const original=createPipelinePlan({config:context.config,identity:{...identity,repository:identity.repository||context.env.GITHUB_REPOSITORY},request});
  writeFileSync(path,JSON.stringify({...plan,pipeline:original},null,2)+'\n');
}
export function validateOriginalPlan(plan) {
  if (!plan?.pipeline) return null;
  const original=validatePipelinePlan(plan.pipeline);
  const candidate=plan.candidate_sha??plan.candidate,version=plan.version??plan.next?.version;
  if (original.identity.candidate_sha!==candidate||original.identity.version!==version) throw Error('Original engine and pipeline identities differ');
  for(const [name,actual]of Object.entries({tag:plan.tag??plan.next?.gitTag,notes:plan.notes,repository:plan.repository}))
    if(actual!==undefined&&original.identity[name]!==actual)throw Error(`Original pipeline ${name} identity differs from engine record`);
  return original;
}
// Reporting retains diagnostics; effectful operations still use strict validation.
export function inspectReportPlan(plan) {
  try {return {original:validateOriginalPlan(plan),error:null};}
  catch(error) {return {original:null,error:`Original pipeline input is invalid: ${error.message}`};}
}
export function configurationForOperation(config,profile) {
  const normalized=normalizeConfig(config);
  if(normalized.schema_version===2&&profile&&profile!==normalized.profile)throw Error('Profile override conflicts with versioned composition');
  return normalized;
}
