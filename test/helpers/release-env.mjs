import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function releaseEnv(cwd) {
  const bin = join(cwd, 'guard-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nprintf "%s\\n" "$CANDIDATE_SHA"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$READ_MODE" in failed) exit 23;; empty) exit 0;; stale) echo stale;; *) echo "$CANDIDATE_SHA";; esac\n', { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, CANDIDATE_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/fixture' };
}

export function releaseDecision(cwd, version) {
  const nextRelease = { version, gitTag: `v${version}`, notes: 'Original fixture notes' };
  writeFileSync(join(cwd, 'release-input/analysis.json'), JSON.stringify({candidate_sha:'a'.repeat(40),version,tag:nextRelease.gitTag,notes:nextRelease.notes,baseline_tag:'v1.0.0'}));
  return nextRelease;
}
