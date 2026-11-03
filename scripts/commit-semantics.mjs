// Stateless semantic-release hook: use the engine's accepted release boundary.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function analyzeCommits(_options, { lastRelease = {}, env = process.env, cwd = process.cwd() }) {
  const requireTool = createRequire(env.RELEASE_TOOLS
    ? join(env.RELEASE_TOOLS, 'package.json') : import.meta.url);
  const { default: importFrom } = await import(pathToFileURL(requireTool.resolve('import-from-esm')).href);
  const [lint, config, preset] = await Promise.all([
    '@commitlint/lint', '@commitlint/config-conventional', 'conventional-changelog-conventionalcommits',
  ].map((name) => importFrom(env.RELEASE_TOOLS || cwd, name)));
  const parserOpts = preset().parser;
  const rules = { ...config.rules, 'body-max-line-length': [0], 'footer-max-line-length': [0] };
  // analyzeCommits input is prefiltered for release-skip markers. Re-read this same
  // engine-selected range so such markers cannot hide invalid messages from lint.
  const range = lastRelease.gitHead ? `${lastRelease.gitHead}..HEAD` : 'HEAD';
  const history = execFileSync('git', ['log', '-z', '--format=%H%x00%B', range],
    { cwd, env, encoding: 'utf8', timeout: 10000 }).split('\0');
  for (let index = 0; index + 1 < history.length; index += 2) {
    const [hash, message] = history.slice(index, index + 2);
    const result = await lint(message, rules, { parserOpts, defaultIgnores: false });
    if (!message.trim() || !result.valid || result.warnings.length) {
      const problems = [...result.errors, ...result.warnings].map(({ message }) => message).join('; ');
      throw new Error(`Invalid Conventional Commit ${hash || ''}: ${problems || 'empty message'}`);
    }
  }
  // The standard analyzer alone determines the version increment.
  return null;
}
