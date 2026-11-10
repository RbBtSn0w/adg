import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Release business data is independent of the delivery service and CI provider.
import {createHash} from 'node:crypto';
import {normalizeCadence,workflowJobIds} from './cadence.mjs';

export const protocolVersion = 1;
const operations = new Set(['preflight', 'execute', 'observe', 'assessRecovery', 'recover']);
const materialKinds = new Set(['source', 'files', 'remote-build']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fact = (condition, message) => {if (!condition) throw new Error(message);};
const identifier = value => typeof value === 'string' && idPattern.test(value);
const text = value => typeof value === 'string' && value.length > 0;
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  fact(object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'Protocol data must contain JSON values');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export const digest = value => 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function immutable(value) {
  const copy = structuredClone(value);
  const freeze = node => {if (node && typeof node === 'object') {Object.values(node).forEach(freeze); Object.freeze(node);} return node;};
  return freeze(copy);
}
function uniqueIds(values, label) {
  fact(Array.isArray(values) && values.every(identifier) && new Set(values).size === values.length, `Invalid or duplicate ${label}`);
}
function externalBindings(value = {}) {
  fact(object(value), 'External execution bindings must be an object');
  for(const [provider,jobs] of Object.entries(value)) {
    fact(identifier(provider), 'Invalid external execution provider');
    uniqueIds(jobs, 'external execution jobs');
    fact(jobs.length > 0, 'External execution provider must declare jobs');
  }
  return immutable(value);
}
function materialRole(role, input) {
  fact(object(role) && identifier(role.role) && materialKinds.has(role.kind), 'Invalid material role');
  if (input) fact(identifier(role.from_stage), 'Input material needs a producer stage');
}
export function validatePipeline(pipeline, intendedTargets) {
  fact(object(pipeline) && Array.isArray(pipeline.stages) && pipeline.stages.length > 0, 'Pipeline stages are required');
  fact(Array.isArray(pipeline.goals) && pipeline.goals.length > 0, 'Pipeline goals are required');
  uniqueIds(intendedTargets, 'intended targets');
  uniqueIds(pipeline.stages.map(stage => stage?.id), 'stage IDs');
  uniqueIds(pipeline.goals.map(goal => goal?.id), 'goal IDs');
  fact(JSON.stringify([...intendedTargets].sort()) === JSON.stringify(pipeline.goals.map(goal => goal.id).sort()), 'Pipeline goals must match every intended target');
  const stages = new Map(pipeline.stages.map(stage => [stage.id, stage]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    fact(!visiting.has(id), 'Pipeline dependency cycle');
    if (visited.has(id)) return;
    const stage = stages.get(id);
    fact(stage, `Missing pipeline dependency: ${id}`);
    uniqueIds(stage.depends_on, 'stage dependencies');
    visiting.add(id);stage.depends_on.forEach(visit);visiting.delete(id);visited.add(id);
  }
  for (const stage of stages.values()) {
    fact(identifier(stage.implementation) && operations.has(stage.operation), 'Stage needs a supported operation and implementation');
    fact(['read','write','local'].includes(stage.effect), 'Stage effect must be read, write or local');
    fact(object(stage.execution) && identifier(stage.execution.provider) && text(stage.execution.job), 'Stage execution binding is required');
    fact(stage.when === undefined || ['always','release-needed'].includes(stage.when), 'Unsupported stage condition');
    fact(Array.isArray(stage.inputs) && Array.isArray(stage.outputs), 'Stage material roles are required');
    stage.inputs.forEach(role => materialRole(role, true));stage.outputs.forEach(role => materialRole(role, false));
    uniqueIds(stage.outputs.map(role => role.role), 'output roles');
    if (['observe','preflight','assessRecovery'].includes(stage.operation)) fact(stage.effect === 'read', 'Read-only capability cannot declare a write');
    visit(stage.id);
  }
  function ancestor(stage, id) {return stage.depends_on.some(parent => parent === id || ancestor(stages.get(parent), id));}
  for (const stage of stages.values()) for (const input of stage.inputs) {
    fact(stages.has(input.from_stage) && ancestor(stage, input.from_stage), 'Material producer must be a dependency');
    fact(stages.get(input.from_stage).outputs.some(role => role.role === input.role && role.kind === input.kind), 'Material input/output kind mismatch');
  }
  for (const goal of pipeline.goals) {
    uniqueIds(goal.stages, 'goal stages');
    fact(goal.stages.length > 0 && goal.stages.every(id => stages.has(id)), 'Goal needs existing stages');
    fact(typeof goal.asynchronous === 'boolean' && ['supported','unsupported'].includes(goal.recovery), 'Goal must declare observation and recovery semantics');
  }
  return immutable(pipeline);
}
export function normalizeConfig(config = {}) {
  fact(object(config), 'Release configuration must be an object');
  const version = config.schema_version ?? 1;
  fact([1,2].includes(version), 'Unsupported release configuration version');
  if (version === 1) {
    fact(config.protocol_version === undefined && (config.pipeline === undefined || config.pipeline === null), 'Pipeline contracts require configuration schema v2');
    return {...structuredClone(config), schema_version: 1, cadence: config.cadence===null?null:normalizeCadence(config.cadence), pipeline: null};
  }
  fact(config.protocol_version === protocolVersion, 'Unsupported pipeline protocol version');
  fact(config.cadence !== undefined, 'Versioned release configuration requires an explicit cadence');
  return immutable({...config, cadence: normalizeCadence(config.cadence), external_execution_bindings:externalBindings(config.external_execution_bindings), pipeline: validatePipeline(config.pipeline, config.intended_targets)});
}
export function validateIdentity(identity) {
  fact(object(identity) && /^[\w.-]+\/[\w.-]+$/.test(identity.repository || '') && shaPattern.test(identity.candidate_sha || ''), 'Invalid release repository or candidate identity');
  fact(typeof identity.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(identity.version), 'Invalid release version identity');
  fact(text(identity.tag) && typeof identity.notes === 'string', 'Release identity requires exact tag and complete notes');
  if (identity.notes_sha256 !== undefined) fact(identity.notes_sha256 === digest(identity.notes), 'Release notes digest mismatch');
  return immutable({repository:identity.repository,candidate_sha:identity.candidate_sha,baseline_tag:identity.baseline_tag??null,version:identity.version,tag:identity.tag,notes:identity.notes,notes_sha256:digest(identity.notes)});
}
export function createPipelinePlan({config, identity, request = {trigger_kind:'unknown'}}) {
  const normalized = normalizeConfig(config);
  if (!normalized.pipeline) return null;
  fact(object(request) && ['scheduled','manual','ci','unknown'].includes(request.trigger_kind), 'Invalid release request kind');
  const original = validateIdentity(identity);
  const body = {protocol_version: protocolVersion, release_id: digest({repository:original.repository,candidate_sha:original.candidate_sha,version:original.version,tag:original.tag}), identity:original,
    configuration_digest:digest(config), pipeline:normalized.pipeline, request:structuredClone(request),
    ...(config.presentation ? {presentation:structuredClone(config.presentation)} : {})};
  return immutable({...body, digest:digest(body)});
}
export function validatePipelinePlan(plan) {
  fact(object(plan) && plan.protocol_version === protocolVersion && digestPattern.test(plan.digest || ''), 'Unsupported or invalid original pipeline plan');
  const {digest:expected, ...body} = plan;
  fact(digest(body) === expected, 'Original pipeline plan digest mismatch');
  validateIdentity(plan.identity);
  fact(digestPattern.test(plan.configuration_digest || '') && plan.release_id === digest({repository:plan.identity.repository,candidate_sha:plan.identity.candidate_sha,version:plan.identity.version,tag:plan.identity.tag}), 'Original pipeline identity mismatch');
  validatePipeline(plan.pipeline, plan.pipeline.goals.map(goal => goal.id));
  return immutable(plan);
}
export function validateMaterial(material) {
  fact(object(material) && materialKinds.has(material.kind), 'Unsupported material kind');
  if (material.kind === 'source') fact(text(material.repository) && shaPattern.test(material.candidate_sha || ''), 'Exact source material required');
  if (material.kind === 'files') {
    fact(object(material.producer) && text(material.producer.id) && Number.isSafeInteger(material.producer.attempt) && material.producer.attempt > 0, 'Immutable material producer required');
    fact(object(material.locator) && identifier(material.locator.provider) && text(material.locator.id), 'Immutable storage locator required');
    fact(object(material.files) && Object.keys(material.files).length > 0 && Object.entries(material.files).every(([name,hash]) => name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..') && digestPattern.test(hash)), 'Invalid sealed material inventory');
  }
  if (material.kind === 'remote-build') fact(identifier(material.provider) && text(material.id) && shaPattern.test(material.candidate_sha || '') && text(material.version) && Array.isArray(material.evidence) && material.evidence.length > 0 && material.evidence.every(item => object(item) && text(item.url) && Number.isFinite(Date.parse(item.observed_at))), 'Remote build needs exact-source observed evidence');
  return immutable(material);
}
export function withPipelineResult(input, {config = {}, plan} = {}) {
  const original = plan?.pipeline ? validatePipelinePlan(plan.pipeline) : null;
  if (original) fact(original.identity.candidate_sha === input.candidate_sha && original.identity.version === input.version, 'Result differs from original pipeline identity');
  if(original)for(const [name,actual]of Object.entries({tag:plan.tag??plan.next?.gitTag,notes:plan.notes,repository:plan.repository}))
    if(actual!==undefined)fact(original.identity[name]===actual,`Original pipeline ${name} identity differs from result plan`);
  const normalized = original ? null : normalizeConfig(config);
  if(!original&&input.pipeline) {
    fact(input.pipeline.protocol_version===protocolVersion&&Array.isArray(input.pipeline.goals),'Unsupported pipeline result protocol');
    const goals=structuredClone(input.pipeline.goals);
    uniqueIds(goals.map(goal=>goal.id),'result goal IDs');
    fact(Array.isArray(input.intended_targets)&&JSON.stringify([...input.intended_targets].sort())===JSON.stringify(goals.map(goal=>goal.id).sort()),'Existing result goal set is inconsistent');
    // Without the original plan, a projection cannot shed previously required goals.
    for(const goal of normalized.pipeline?.goals||[]) {
      const previous=goals.find(item=>item.id===goal.id);
      if(!previous)goals.push(structuredClone(goal));
      else {
        previous.asynchronous=previous.asynchronous&&goal.asynchronous;
        previous.recovery=previous.recovery==='supported'&&goal.recovery==='supported'?'supported':'unsupported';
      }
    }
    return {...input,intended_targets:goals.map(goal=>goal.id),pipeline:{...structuredClone(input.pipeline),goals}};
  }
  const pipeline = original?.pipeline ?? normalized.pipeline;
  if (!pipeline) return input;
  if(!original && Array.isArray(input.intended_targets) && input.intended_targets.some(id=>!pipeline.goals.some(goal=>goal.id===id))) {
    // A legacy producer can require goals the current composition cannot describe.
    // Keep its actual required-target path instead of fabricating executable stages.
    return {...input,intended_targets:[...new Set([...pipeline.goals.map(goal=>goal.id),...input.intended_targets])],asynchronous:false};
  }
  const intended_targets = pipeline.goals.map(goal => goal.id);
  return {...input, intended_targets, pipeline:{protocol_version:protocolVersion, ...structuredClone(pipeline),
    ...(input.pipeline?.stage_observations?{stage_observations:structuredClone(input.pipeline.stage_observations)}:{}),
    source:original?'original-plan':'current-configuration', ...(original?{plan_digest:original.digest}:{})},
    ...((original?.presentation ?? config.presentation) ? {presentation:structuredClone(original?.presentation ?? config.presentation)} : {})};
}

export function writeCompatibleResult(writer, output, input, options) {
  if(input.pipeline&&!writer.supportedPipelineProtocols?.includes(input.pipeline.protocol_version)) throw Error('Result writer is incompatible with the pipeline protocol');
  return writer.writeResult(output,input,options);
}

export function validateExecutionBindings(pipeline, available) {
  if(!pipeline)return;
  for(const stage of pipeline.stages) {
    const jobs=available[stage.execution.provider];
    if(!Object.hasOwn(available,stage.execution.provider)||!Array.isArray(jobs)||!jobs.includes(stage.execution.job))throw Error(`Unknown execution binding for stage ${stage.id}`);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]!=='check'||process.argv.length>5)throw Error('Usage: pipeline-contract.mjs check [CONFIG] [WORKFLOW]');
  const config=normalizeConfig(JSON.parse(readFileSync(process.argv[3]||'.github/release-train.json','utf8')));
  if(config.pipeline) {
    const local={'github-actions':workflowJobIds(readFileSync(process.argv[4]||'.github/workflows/release.yml','utf8'))};
    for(const provider of Object.keys(config.external_execution_bindings))fact(!Object.hasOwn(local,provider),'External execution cannot override a local provider');
    validateExecutionBindings(config.pipeline,{...local,...config.external_execution_bindings});
  }
  process.stdout.write('Release pipeline contract is valid.\n');
  if(Object.keys(config.external_execution_bindings||{}).length)process.stdout.write('External execution declarations require provider-side verification: '+Object.keys(config.external_execution_bindings).join(', ')+'.\n');
}
