// Use the same complete semantic messages as the official version analyzer.
import { loadReleaseTool, normalizeReleaseCommits } from './commit-semantics.mjs';
export async function generateNotes(options, context) {
  const engine = await loadReleaseTool('@semantic-release/release-notes-generator', context);
  return engine.generateNotes(options, { ...context, commits: await normalizeReleaseCommits(context) });
}
