# AGENTS.md

Guidance for AI agents (and humans) contributing to this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/branching-and-release.md](docs/branching-and-release.md) for the full
process.

## Branch & PR rules

- **All pull requests must target the `beta` branch.** Never open a PR against
  `main`. `main` is reserved for stable releases and is updated only by a
  maintainer release PR from `beta`.
- **Never push directly to `main` or `beta`.** Both are protected; all changes
  land via PR + review + passing CI.
- Branch off `beta` for new work: `git switch beta && git pull && git switch -c <type>/<short-desc>`.
- The CI check `Validate base branch` fails any PR whose base is not `beta`
  (the only exception is the maintainer release PR `beta → main`).

## Commit messages

- Use [Conventional Commits](https://www.conventionalcommits.org/). The version
  bump, `CHANGELOG.md`, and GitHub Release notes are derived from them by
  `semantic-release`.
- Type → release notes section: `feat:` → **Added**, `fix:`/`revert:` →
  **Fixed**, `refactor:`/`perf:` → **Changed**. `chore:`/`test:`/`build:`/`ci:`/
  `style:` are hidden from the notes.
- Mark breaking changes with `!` or a `BREAKING CHANGE:` footer.

## Local checks before opening a PR

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## Do not

- Do not stage, commit, push, or open PRs unless explicitly asked.
- Do not edit release/CI config (`.releaserc.json`, `.github/workflows/*`),
  lockfiles, or branch-protection scripts without surfacing the risk first.
- Do not bypass branch protection or merge to `main` outside the documented
  `beta → main` release flow.
