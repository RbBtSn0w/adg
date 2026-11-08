// Stateless semantic-release hooks: the official engine owns versions and notes.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadReleaseTool(name, { env = process.env } = {}) {
  const requireTool = createRequire(env.RELEASE_TOOLS
    ? join(env.RELEASE_TOOLS, 'package.json') : import.meta.url);
  return import(pathToFileURL(requireTool.resolve(name)).href);
}

function history({ lastRelease = {}, env = process.env, cwd = process.cwd() }) {
  const range = lastRelease.gitHead ? `${lastRelease.gitHead}..HEAD` : 'HEAD';
  const fields = execFileSync('git', ['log', '-z', '--format=%H%x00%P%x00%B', range],
    { cwd, env, encoding: 'utf8', timeout: 10000 }).split('\0');
  const records = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [hash, parentText, message] = fields.slice(index, index + 3);
    records.push({ hash: hash.trim(), parents: parentText.trim().split(/\s+/).filter(Boolean), message });
  }
  return records;
}

function semanticMessage(message, parents) {
  const newline = message.indexOf('\n');
  const header = message.split(/\r?\n/, 1)[0];
  if (parents.length !== 1 || !/^Merge pull request #\d+ from [^\r\n]+$/.test(header)) return message;
  // Expand one historical envelope, never recursively; keep every breaking footer.
  return newline < 0 ? '' : message.slice(newline + 1).trimStart();
}

async function semanticLint(context) {
  const { env = process.env, cwd = process.cwd() } = context;
  const { default: importFrom } = await loadReleaseTool('import-from-esm', context);
  const [lint, config, preset] = await Promise.all([
    '@commitlint/lint', '@commitlint/config-conventional', 'conventional-changelog-conventionalcommits',
  ].map(name => importFrom(env.RELEASE_TOOLS || cwd, name)));
  const parserOpts = (await preset()).parser;
  const rules = { 'type-empty': [2, 'never'], 'subject-empty': [2, 'never'],
    'type-enum': config.rules['type-enum'] };
  return async (message, hash) => {
    const result = await lint(message, rules, { parserOpts, defaultIgnores: false });
    if (!message.trim() || !result.valid || result.warnings.length) {
      const problems = [...result.errors, ...result.warnings].map(({ message }) => message).join('; ');
      throw new Error(`Invalid Conventional Commit ${hash || ''}: ${problems || 'empty message'}`);
    }
  };
}

export async function analyzeCommits(options = {}, context) {
  const { lastRelease = {}, logger } = context;
  if (options.requireExistingRelease && !lastRelease.gitHead) {
    throw new Error('Existing product release baseline is unverified; publication is disabled.');
  }
  const validate = await semanticLint(context);
  // Re-read the complete engine range: release-skip markers cannot hide bad messages.
  for (const { hash, parents, message } of history(context)) {
    if (!lastRelease.gitHead && parents.length === 0) {
      logger?.log('Recorded first-release initialization snapshot %s', hash);
      continue;
    }
    const header = message.split(/\r?\n/, 1)[0];
    const mergeMetadata = /^Merge pull request #\d+ from [^\r\n]+$/.test(header)
      || /^Merge (?:remote-tracking )?(?:branch|tag) '[^'\r\n]+'(?: (?:into|of) [^\r\n]+)?$/.test(header);
    if (parents.length > 1 && mergeMetadata) continue;
    await validate(semanticMessage(message, parents), hash);
  }
  return null;
}

export async function normalizeReleaseCommits(context) {
  const records = new Map(history(context).map(record => [record.hash, record]));
  const validate = await semanticLint(context);
  return Promise.all(context.commits.map(async commit => {
    const record = records.get(commit.hash);
    if (!record) throw new Error(`Release commit has no parent evidence: ${commit.hash}`);
    const message = semanticMessage(commit.message, record.parents);
    if (message === commit.message) return { ...commit };
    await validate(message, commit.hash);
    // Preserve provenance without changing Git or mutating the engine input objects.
    return { ...commit, message, originalMessage: commit.originalMessage ?? commit.message };
  }));
}
