// Validate GitHub's original immutable handoff before reading any recovery payload.
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const id = value => /^(?:[1-9]\d*)$/.test(String(value ?? '')) ? String(value) : null;
const requireFact = (condition, message) => { if (!condition) throw new Error(message); };

export function verifyRecoverySource({ run, artifact, repository, workflow = '.github/workflows/release.yml', sourceRunId, artifactId }) {
  requireFact(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Expected repository is required');
  requireFact(id(sourceRunId) && id(artifactId), 'Original run and artifact IDs must be positive integers');
  requireFact(run && id(run.id) === id(sourceRunId), 'Original workflow run ID mismatch');
  requireFact(run.repository?.full_name?.toLowerCase() === repository.toLowerCase(), 'Original workflow belongs to another repository');
  requireFact(run.path === workflow, 'Recovery requires the original release workflow');
  requireFact(run.head_branch === 'main' && ['schedule', 'workflow_dispatch'].includes(run.event), 'Original run was not a main release entrypoint');
  requireFact(run.status === 'completed', 'Original release run is not complete');
  requireFact(/^[a-f0-9]{40}$/.test(run.head_sha || ''), 'Original candidate SHA is invalid');
  requireFact(artifact && id(artifact.id) === id(artifactId), 'Artifact ID mismatch');
  requireFact(artifact.expired === false, 'Original immutable artifact expired or is unavailable');
  requireFact(id(artifact.workflow_run?.id) === id(sourceRunId), 'Artifact belongs to another workflow run');
  requireFact(artifact.workflow_run.head_sha === run.head_sha, 'Artifact candidate differs from the original workflow');
  return { candidate_sha: run.head_sha, source_run_id: id(sourceRunId), artifact_id: id(artifactId) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const runPath = value('--run');
  const artifactPath = value('--artifact');
  if (!runPath || !artifactPath) throw new Error('Provide --run and --artifact metadata files');
  const result = verifyRecoverySource({
    run: JSON.parse(readFileSync(runPath, 'utf8')),
    artifact: JSON.parse(readFileSync(artifactPath, 'utf8')),
    repository: value('--repository'), workflow: value('--workflow'),
    sourceRunId: value('--source-run-id'), artifactId: value('--artifact-id'),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(result).map(([key, data]) => `${key}=${data}`).join('\n') + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
}
