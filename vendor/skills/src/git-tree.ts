import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * ADG-added file (see vendor/skills/PROVENANCE.md → Local patches).
 *
 * Return the git *tree object SHA* for a folder inside a freshly cloned repo —
 * the SAME 40-hex value GitHub's Trees API returns and that
 * `getSkillFolderHashFromTree` (blob.ts) compares against at update time.
 *
 * Used by `add.ts` so a github source that fell back to a `git clone` at install
 * still records a tree SHA, not a sha256 content hash. Otherwise the install and
 * update hashing schemes diverge and every update perpetually re-flags the skill
 * (the bug that made a collection repo "fully update" on every run).
 *
 * `folder === ''` means the repo root. Returns null if git can't resolve it.
 *
 * Deliberately uses `child_process` rather than simple-git: this keeps the file
 * free of simple-git's typings, which don't satisfy ADG's strict tsconfig when a
 * test pulls the module into the typecheck graph.
 */
export async function gitTreeShaForFolder(
  repoDir: string,
  folder: string
): Promise<string | null> {
  const spec = folder ? `HEAD:${folder}` : 'HEAD^{tree}';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', spec]);
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
