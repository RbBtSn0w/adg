import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT = { schedule: { enabled: true, cron: '0 15 * * 5', timezone: 'Asia/Shanghai' }, manual: { enabled: true } };

function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function validateCron(cron) {
  if (typeof cron !== 'string' || cron !== cron.trim() || cron.split(/\s+/).length !== 5) throw new Error('cadence cron must have five fields');
  const fields = cron.split(/\s+/);
  const names = [{}, {}, {}, Object.fromEntries('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').map((v, i) => [v, i + 1])), Object.fromEntries('SUN MON TUE WED THU FRI SAT'.split(' ').map((v, i) => [v, i]))];
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  fields.forEach((field, index) => {
    const [min, max] = bounds[index];
    const number = token => {
      const value = names[index][token] ?? (/^(0|[1-9]\d*)$/.test(token) ? Number(token) : NaN);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid cadence cron field: ${field}`);
      return value;
    };
    for (const item of field.split(',')) {
      const parts = item.split('/');
      if (parts.length > 2 || (parts.length === 2 && (!/^[1-9]\d*$/.test(parts[1]) || Number(parts[1]) > max - min + 1))) throw new Error(`Invalid cadence cron step: ${item}`);
      const base = parts[0];
      if (base === '*') continue;
      const range = base.split('-');
      if (range.length > 2 || (parts.length === 2 && range.length !== 2)) throw new Error(`Unsupported cadence cron form: ${item}`);
      const start = number(range[0]);
      if (range.length === 2 && number(range[1]) < start) throw new Error(`Invalid cadence cron range: ${item}`);
    }
  });
  // Avoid the provider-specific OR interpretation of simultaneously restricted days.
  if (fields[2] !== '*' && fields[4] !== '*') throw new Error('cadence cron cannot restrict both day-of-month and day-of-week');
  if (/^\d+$/.test(fields[2]) && /^\d+$/.test(fields[3])) {
    const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(fields[3]) - 1];
    if (Number(fields[2]) > maxDay) throw new Error('cadence cron specifies an impossible calendar date');
  }
  return fields.join(' ');
}

/** Absent cadence preserves a legacy entrypoint; an explicit object opts into defaults. */
export function normalizeCadence(value, { legacy = false } = {}) {
  if (value === undefined) return null;
  object(value, ['schedule', 'manual'], 'cadence');
  const result = structuredClone(DEFAULT);
  for (const [section, fields] of [['schedule', ['enabled', 'cron', 'timezone']], ['manual', ['enabled']]]) {
    if (Object.hasOwn(value, section)) {
      object(value[section], fields, `cadence.${section}`);
      Object.assign(result[section], value[section]);
    }
    if (typeof result[section].enabled !== 'boolean') throw new Error(`cadence.${section}.enabled must be boolean`);
  }
  result.schedule.cron = validateCron(result.schedule.cron);
  const timezone = result.schedule.timezone;
  if (typeof timezone !== 'string' || (timezone !== 'UTC' && !timezone.includes('/'))) throw new Error('cadence timezone must be an IANA timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); }
  catch { throw new Error(`Invalid cadence timezone: ${timezone}`); }
  return result;
}

function yamlTools() {
  try {
    const requireTool = createRequire(process.env.RELEASE_TOOLS ? join(resolve(process.env.RELEASE_TOOLS), 'package.json') : import.meta.url);
    return requireTool('yaml');
  } catch { throw new Error('Cadence projection requires yaml in RELEASE_TOOLS; provision the pinned release tools first'); }
}

function parseWorkflow(source) {
  const yaml = yamlTools();
  const document = yaml.parseDocument(source, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length) throw new Error(`Invalid workflow YAML: ${document.errors[0].message}`);
  const root = document.contents;
  if (!yaml.isMap(root)) throw new Error('Workflow must be a YAML mapping');
  const eventPair = root.items.find(pair => pair.key?.value === 'on');
  if (!eventPair || !yaml.isMap(eventPair.value)) throw new Error('Workflow on events must be an explicit YAML mapping');
  // Aliases and anchors can make a seemingly local edit change unrelated event semantics.
  yaml.visit(eventPair.value, (_, node) => {
    if (yaml.isAlias(node) || node?.anchor) throw new Error('Workflow events cannot contain aliases or anchors for cadence maintenance');
  });
  const events = eventPair.value;
  const schedule = events.items.find(pair => pair.key?.value === 'schedule');
  // Only event data belongs to this projection; job aliases and other job details
  // remain untouched and need not be materialized.
  const data = { on: events.toJSON() };
  const manual = Object.hasOwn(data.on, 'workflow_dispatch');
  return { yaml, events, schedule, data, manual, jobs:root.get('jobs',true) };
}

export function workflowJobIds(source) {
  const parsed=parseWorkflow(source);
  if(!parsed.yaml.isMap(parsed.jobs))throw Error('Workflow jobs must be an explicit YAML mapping');
  return parsed.jobs.items.map(pair=>pair.key.value);
}

function desiredSchedule(cadence) {
  return cadence.schedule.enabled ? [{ cron: cadence.schedule.cron, timezone: cadence.schedule.timezone }] : undefined;
}

export function checkCadenceProjection(source, value) {
  if (value === undefined || value === null) return { matches: true, preserved: true };
  const cadence = normalizeCadence(value);
  const parsed = parseWorkflow(source);
  const desired = desiredSchedule(cadence);
  const actual = parsed.data.on.schedule;
  const scheduleMatches = desired === undefined
    ? !Object.hasOwn(parsed.data.on, 'schedule')
    : Array.isArray(actual) && actual.length === 1 && actual[0] && typeof actual[0] === 'object'
      && Object.keys(actual[0]).every(key => key === 'cron' || key === 'timezone')
      && actual[0].cron === desired[0].cron && (actual[0].timezone ?? 'UTC') === desired[0].timezone;
  const manualMatches = parsed.manual === cadence.manual.enabled;
  return { matches: scheduleMatches && manualMatches, scheduleMatches, manualMatches, expected: desired ?? [], actual: actual ?? [] };
}

/** Maintenance-only source projection. Never called by a release execution. */
export function updateCadenceProjection(source, value) {
  if (value === undefined || value === null) return source;
  const cadence = normalizeCadence(value);
  const parsed = parseWorkflow(source);
  if (parsed.manual !== cadence.manual.enabled) throw new Error('cadence manual setting differs from workflow_dispatch; update that event explicitly in a separately reviewed change');
  if (checkCadenceProjection(source, cadence).matches) return source;
  if (parsed.events.flow) throw new Error('Cadence maintenance requires a block YAML event mapping');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let start;
  let end;
  let indent;
  if (parsed.schedule) {
    start = source.lastIndexOf('\n', parsed.schedule.key.range[0] - 1) + 1;
    indent = source.slice(start, parsed.schedule.key.range[0]);
    end = parsed.schedule.value?.range?.[2] ?? parsed.schedule.key.range[2];
    if (!parsed.schedule.value || (parsed.yaml.isScalar(parsed.schedule.value) && parsed.schedule.value.value === null)) {
      const newline = source.indexOf('\n', parsed.schedule.key.range[0]);
      end = newline === -1 ? source.length : newline + 1;
    }
    if (end < source.length && source[end - 1] !== '\n') throw new Error('Unsupported schedule YAML source boundary');
  } else {
    const first = parsed.events.items[0];
    if (!first) throw new Error('Cadence maintenance requires an existing event to preserve event boundaries');
    start = source.lastIndexOf('\n', first.key.range[0] - 1) + 1;
    end = start;
    indent = source.slice(start, first.key.range[0]);
  }
  if (!/^ +$/.test(indent)) throw new Error('Unsupported cadence event indentation');
  const replacement = cadence.schedule.enabled
    ? `${indent}schedule:${eol}${indent}  - cron: ${JSON.stringify(cadence.schedule.cron)}${eol}${indent}    timezone: ${JSON.stringify(cadence.schedule.timezone)}${eol}` : '';
  const updated = source.slice(0, start) + replacement + source.slice(end);
  if (!checkCadenceProjection(updated, cadence).matches) throw new Error('Cadence projection failed validation');
  return updated;
}

function main(args) {
  const mode = args.shift();
  if (!['check', 'update'].includes(mode)) throw new Error('Usage: cadence.mjs check|update [--config path] [--workflow path]');
  const paths = { '--config': '.github/release-train.json', '--workflow': '.github/workflows/release.yml' };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (!Object.hasOwn(paths, flag) || seen.has(flag) || !args.length || args[0].startsWith('--')) throw new Error('Invalid cadence CLI arguments');
    seen.add(flag);
    paths[flag] = args.shift();
  }
  const config = JSON.parse(readFileSync(paths['--config'], 'utf8'));
  const cadence = normalizeCadence(config.cadence);
  const source = readFileSync(paths['--workflow'], 'utf8');
  if (mode === 'update') {
    const updated = updateCadenceProjection(source, cadence);
    if (updated !== source) writeFileSync(paths['--workflow'], updated);
  }
  const result = checkCadenceProjection(mode === 'update' ? readFileSync(paths['--workflow'], 'utf8') : source, cadence);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.matches) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
