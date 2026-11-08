// Thin input adaptation; the official plugin retains all version rules.
import { loadReleaseTool, normalizeReleaseCommits } from './commit-semantics.mjs';
export async function analyzeCommits(options, context) {
  const engine = await loadReleaseTool('@semantic-release/commit-analyzer', context);
  return engine.analyzeCommits(options, { ...context, commits: await normalizeReleaseCommits(context) });
}
