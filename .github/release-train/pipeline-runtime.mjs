// Trusted implementations provide behavior; the coordinator supplies invariants.
import {realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {protocolVersion,object,immutable,validateIdentity,validateMaterial,validatePipelinePlan,digest} from './pipeline-contract.mjs';

const readOnly = new Set(['preflight','observe','assessRecovery']);
const operations = new Set([...readOnly,'execute','recover']);
export function validateImplementation(implementation) {
  const descriptor = implementation?.descriptor;
  if (!object(descriptor) || descriptor.protocol_version !== protocolVersion || !/^[\w.-]+$/.test(descriptor.id || '') || !object(descriptor.operations) || !Object.keys(descriptor.operations).length) throw Error('Unsupported capability descriptor');
  for (const [name, declaration] of Object.entries(descriptor.operations)) {
    if (!operations.has(name) || !object(declaration) || !['read','write','local'].includes(declaration.effect)) throw Error('Invalid capability operation declaration');
    if (readOnly.has(name) && declaration.effect !== 'read') throw Error('Observation capabilities are read-only');
    if (typeof implementation[name] !== 'function') throw Error(`Missing declared capability handler: ${name}`);
  }
  return immutable(descriptor);
}
export async function loadImplementation({cwd=process.cwd(),path}) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw Error('A repository-relative implementation path is required');
  const root = realpathSync(cwd), location = resolve(root,path), delta = relative(root,location);
  if (delta === '..' || delta.startsWith('..'+(process.platform==='win32'?'\\':'/')) || isAbsolute(delta)) throw Error('Implementation must stay inside the repository');
  const actual = realpathSync(location), actualDelta = relative(root,actual);
  if (actualDelta === '..' || actualDelta.startsWith('..'+(process.platform==='win32'?'\\':'/')) || isAbsolute(actualDelta)) throw Error('Implementation must stay inside the repository');
  const implementation = await import(pathToFileURL(actual).href);
  validateImplementation(implementation);
  return implementation;
}
export async function invokeCapability({implementation,operation,context}) {
  const descriptor = validateImplementation(implementation), declaration = descriptor.operations[operation];
  if (!declaration) throw Error(`Unsupported capability operation: ${operation}`);
  if (!object(context)) throw Error('A capability context is required');
  validateIdentity(context.identity);
  for (const material of context.materials || []) {
    validateMaterial(material);
    const matches=material.kind==='files'?material.identity_digest===digest(context.identity):material.candidate_sha===context.identity.candidate_sha && (material.kind==='source'?material.repository===context.identity.repository:material.version===context.identity.version && (material.repository===undefined||material.repository===context.identity.repository));
    if(!matches)throw Error('Material identity differs from original release');
  }
  if (declaration.effect === 'write' && context.publication_enabled !== true) throw Error('Publication is disabled');
  if (declaration.effect === 'write') {
    const effect = context.effect;
    // A provider may be more conservative. Absence of a response never grants another write.
    if (!object(effect) || effect.state !== 'unsent' || typeof effect.key !== 'string' || !effect.key || effect.identity_digest !== digest(context.identity) || effect.intent_verified !== true) throw Error('Accepted or uncertain original requests must be observed; recovery needs a verified unsent intent');
  }
  const result = await implementation[operation](immutable(context));
  if (!object(result)) throw Error('Capability handler must return a structured result');
  if (result.candidate_sha !== undefined && result.candidate_sha !== context.identity.candidate_sha || result.version !== undefined && result.version !== context.identity.version) throw Error('Capability result changed release identity');
  if (operation === 'observe' && ['completed','in-progress'].includes(result.status) && (result.candidate_sha !== context.identity.candidate_sha || result.version !== context.identity.version || !Number.isFinite(Date.parse(result.observed_at)) || !(result.remote_id || result.url))) throw Error('Observation needs exact remote identity and timestamp');
  return immutable(result);
}

export async function runStage({plan,stageId,implementation,materials={},observations={},publication_enabled=false,effect}) {
  const original=validatePipelinePlan(plan),stage=original.pipeline.stages.find(item=>item.id===stageId);
  if(!stage)throw Error('Stage is not in the original pipeline');
  const descriptor=validateImplementation(implementation);
  if(descriptor.id!==stage.implementation||descriptor.operations[stage.operation]?.effect!==stage.effect)throw Error('Stage implementation differs from the original binding');
  for(const dependency of stage.depends_on) {
    const receipt=observations[dependency];
    if(!receipt||receipt.status!=='completed'||receipt.candidate_sha!==original.identity.candidate_sha||receipt.version!==original.identity.version||!Number.isFinite(Date.parse(receipt.observed_at))||!(receipt.remote_id||receipt.url))throw Error('Stage prerequisite is not confirmed for the original release');
  }
  const selected=stage.inputs.map(input=>{
    const material=materials[input.role];
    if(material?.kind!==input.kind)throw Error('Stage material role is unavailable or has a different kind');
    if(material.producer?.stage_id!==input.from_stage||material.plan_digest!==original.digest||material.role!==input.role)throw Error('Material producer or original plan binding differs from the declared input');
    return material;
  });
  if(stage.effect==='write'&&effect?.key!==original.release_id+'/'+stage.id)throw Error('Write effect key differs from the original stage');
  return invokeCapability({implementation,operation:stage.operation,context:{identity:original.identity,plan_digest:original.digest,stage_id:stage.id,materials:selected,publication_enabled,...(effect?{effect}:{})}});
}
