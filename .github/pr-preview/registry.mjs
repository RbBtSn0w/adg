import {appendFileSync} from 'node:fs';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {runSubprocessSync} from '../../src/subprocess.ts';
import {getTracer, recordTelemetryEvent, shutdownTelemetry} from '../../src/telemetry.ts';
import {createNpmObservationBudget, parseNpmIntegrity, parseNpmView} from '../release-train/npm-view.mjs';

const packageName = '@rbbtsn0w/adg';

export async function observePreview({version, readIntegrity, readNext, waitForNext, budget = createNpmObservationBudget()}) {
  let available = false;
  try {
    return await budget.wait(timeout => {
      available ||= readIntegrity(timeout) === true;
      if (!available) return null;

      const remaining = budget.assertRemaining();
      let next;
      try {
        next = readNext(remaining) === version;
      } catch {
        return {available, next: false, status: 'tag-unverified'};
      }
      if (next || !waitForNext) return {available, next, status: 'verified'};
      return null;
    });
  } catch (error) {
    if (error.code !== 'NPM_AVAILABILITY_PENDING') throw error;
    return {available, next: false, status: 'pending'};
  }
}

function npmView(registry, spec, field, timeout) {
  return runSubprocessSync('npm', [
    'view', spec, field, '--json', '--prefer-online', '--registry', registry,
    '--fetch-retries=0', '--fetch-timeout=8000',
  ], {encoding: 'utf8', timeout: Math.min(timeout, 10000)});
}

function currentNext(result) {
  if (result.error) throw result.error;
  const tags = parseNpmView(result.stdout);
  if (result.status !== 0) {
    if (tags?.error?.code === 'E404') return null;
    throw new Error('Could not read registry dist-tags');
  }
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) ||
      Object.values(tags).some(value => typeof value !== 'string')) {
    throw new Error('Invalid registry dist-tags');
  }
  return tags.next ?? null;
}

async function main() {
  const [mode, registry] = process.argv.slice(2);
  const {PREVIEW_VERSION: version, PREVIEW_INTEGRITY: integrity, GITHUB_OUTPUT: output} = process.env;
  if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry) || !version || !integrity ||
      !['probe', 'verify-existing', 'verify-published'].includes(mode)) {
    throw new Error('Invalid preview registry observation input');
  }
  const readIntegrity = timeout =>
    parseNpmIntegrity(npmView(registry, packageName + '@' + version, 'dist.integrity', timeout), integrity);
  if (mode === 'probe') {
    console.log(readIntegrity(10000) === true);
    return;
  }
  const result = await observePreview({
    version, readIntegrity,
    readNext: timeout => currentNext(npmView(registry, packageName, 'dist-tags', timeout)),
    waitForNext: mode === 'verify-published',
  });
  appendFileSync(output, `available=${result.available}\nnext=${result.next}\nobservation=${result.status}\n`);
  recordTelemetryEvent('adg.pr_preview.registry_observation', {
    'adg.preview.available': result.available, 'adg.preview.next': result.next, 'adg.preview.observation': result.status,
  });
  if (result.status === 'pending') {
    console.log('::warning::Registry verification is still pending. The observation window expired.');
    if (!result.available) throw new Error('The exact preview version could not be verified within the observation window');
  } else if (result.status === 'tag-unverified') {
    console.log('::warning::The exact preview is installable. The next tag could not be verified.');
  }
}

if (import.meta.main) {
  const name = 'adg-pr-preview-registry';
  await getTracer('development').startActiveSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes: {'process.executable.name': name, 'process.pid': process.pid},
  }, async span => {
    let exitCode = 0;
    try {
      await main();
    } catch (error) {
      console.error(error.message);
      exitCode = 1;
      process.exitCode = exitCode;
      span.setAttribute('error.type', 'PreviewRegistryError');
      span.setStatus({code: SpanStatusCode.ERROR});
    } finally {
      span.setAttribute('process.exit.code', exitCode);
      span.end();
      await shutdownTelemetry();
    }
  });
}
