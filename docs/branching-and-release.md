# Branching & Release Process

This document describes the branch model, repository protection, and release
cadence for ADG. For the contributor-facing summary see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Goals

- `main` is always stable and is the source of stable releases.
- `beta` is the integration branch; all contributions land here first.
- Stable releases are cut on a maintainer's schedule, not on every PR merge.
- The flow stays compatible with `semantic-release` (already configured).

## Branches

### `main`
- Production-stable code, GitHub default/home branch, source of stable releases.
- No direct pushes. No contributor merges.
- Only updated by a maintainer release PR from `beta`.

### `beta`
- Day-to-day integration branch and the target of every feature/fix PR.
- Continuously tested via CI; merging here publishes a prerelease.

## Enforcement (already in this repo)

| Requirement | Where |
| ----------- | ----- |
| PRs must target `beta` | `.github/workflows/pr-target.yml` |
| PR checklist incl. base = beta | `.github/PULL_REQUEST_TEMPLATE.md` |
| Build/typecheck/test gate | `.github/workflows/ci.yml` |
| Prerelease on `beta`, stable on `main` | `.releaserc.json` |
| Back-merge `main` → `beta` after release | `.github/workflows/sync-main-to-beta.yml` |

The remaining controls — branch protection and merge-permission restriction —
are repository settings and must be applied via the GitHub UI or API (see below).

## Keeping beta in sync with main

The flow is one-directional (`beta → main`), so after every release `main`
gains a `chore(release): … [skip ci]` commit that `beta` lacks — left alone the
branches slowly drift. `sync-main-to-beta.yml` closes that gap by opening a
**back-merge PR (`main → beta`)** automatically.

- **Trigger**: the CI workflow *completing* on `main`. (A `push` trigger would
  miss the release commit, whose `[skip ci]` suppresses push-triggered runs.)
  Also runnable via **Run workflow** (`workflow_dispatch`).
- **Behaviour**: idempotent — opens a PR only when `main` is ahead of `beta` and
  no sync PR is already open. It never pushes to `beta` directly, so branch
  protection still applies.
- **Merging**: merge the sync PR with a **merge commit** (not squash). Version
  lines in `package.json` / `CHANGELOG.md` may conflict — resolve in favour of
  `main`; the next prerelease on `beta` continues from there.
- **Token**: set repo secret `SYNC_TOKEN` (a PAT or the release-bot App token)
  so CI runs on the sync PR and it can satisfy `beta`'s required checks. Without
  it the PR still opens on `GITHUB_TOKEN`, but a maintainer must merge it (a
  token-created PR does not start the `pull_request` CI).

This is the steady-state replacement for the one-time manual `beta = main`
reset done when the model was first established.

## Repository protection setup

Apply once per repository. Requires admin and the `gh` CLI authenticated against
`RbBtSn0w/adg`. A ready script is provided:

```bash
./scripts/setup-branch-protection.sh
```

It creates two **rulesets**:

**`main` ruleset**
- Require a pull request before merging (≥ 1 approving review).
- Require conversation resolution before merging.
- Require status checks to pass: `Test (Node 22)`, `Test (Node 23)`.
- Block direct pushes / non-fast-forward / deletion.
- Restrict who can merge to repository admins + a `release-managers` team
  (edit the script to set your team/actor IDs).

**`beta` ruleset**
- Require a pull request before merging (≥ 1 approving review).
- Require status checks: `Test (Node 22)`, `Test (Node 23)`,
  `Validate base branch`.
- Block direct pushes / deletion.

> Status-check names must match the job names rendered by Actions. If you rename
> CI jobs, update the rulesets.

## Release flow (maintainers)

```
Multiple PRs ─▶ merge into beta ─▶ test & validate ─▶ release prep
            ─▶ open release PR: beta → main ─▶ merge ─▶ stable release
```

1. Let changes accumulate on `beta` (each merge ships a `x.y.z-beta.N` prerelease).
2. When ready to release, open a PR `beta → main`.
   - This is the one PR allowed to target `main`; CI permits it.
3. Merge after CI + review. The push to `main` triggers `semantic-release`,
   which computes the stable version from Conventional Commits, tags it, updates
   `CHANGELOG.md`, and publishes the GitHub Release + npm package + GitHub
   Packages, then updates the Homebrew tap.

### Distribution channels

| Channel | beta push | main (stable) push |
| ------- | --------- | ------------------ |
| npm (`@beta` / `latest`) | ✅ prerelease | ✅ stable |
| GitHub Packages | ✅ | ✅ |
| GitHub Release | prerelease | ✅ |
| Homebrew tap | ❌ skipped | ✅ (when release-bot App configured) |

#### Homebrew publishing

The formula push runs only on **stable `main` releases** and only when the
release-bot GitHub App is configured. The CI steps are guarded by:

```yaml
if: ${{ github.ref == 'refs/heads/main' && vars.RELEASE_BOT_APP_ID != '' }}
```

Required repository configuration (Settings → Secrets and variables → Actions):

| Kind | Name | Purpose |
| ---- | ---- | ------- |
| Variable | `RELEASE_BOT_APP_ID` | App ID of a GitHub App with write access to `RbBtSn0w/homebrew-tap` |
| Secret | `RELEASE_BOT_PRIVATE_KEY` | That App's private key |

Until both are set, npm / GitHub Packages / GitHub Release still publish and CI
stays green; the Homebrew steps are skipped. Once configured, the formula update
activates automatically with no workflow change. Prereleases are additionally
skipped inside `scripts/publish-homebrew-tap.sh`.

### Cadence
Choose what fits the milestone — weekly, bi-weekly, per-milestone, or
per-feature-set. The maintainer decides when to open the `beta → main` PR;
nothing auto-promotes.

## Release notes

Release notes and `CHANGELOG.md` are generated by `semantic-release` from
[Conventional Commits](https://www.conventionalcommits.org/). The
`conventionalcommits` preset in `.releaserc.json` groups commits into named
sections:

| Commit type | Notes section |
| ----------- | ------------- |
| `feat:` | **Added** |
| `fix:`, `revert:` | **Fixed** |
| `refactor:`, `perf:` | **Changed** |
| `chore:`, `test:`, `build:`, `ci:`, `style:` | hidden |

Example commit → notes mapping:

```
feat: support custom provider   → Added
fix: resolve login issue        → Fixed
refactor: simplify provider mgr → Changed
```

### Contributors

`semantic-release` does not emit a contributors list itself (its commit objects
carry git name/email, not GitHub `@handles`). To get real `@handles`, a
best-effort CI step (`Append new contributors to release notes`) runs after a
**stable `main`** release and appends GitHub's native **`## New Contributors`**
section — first-time contributors for the release range — to the GitHub Release
body via the `generate-notes` API.

- Only runs when `semantic-release` actually cut a release (the `package.json`
  version changed); otherwise it no-ops.
- `continue-on-error: true` — it never fails the release; the version/tag/npm
  publish already succeeded by this point.
- The section lands in the **GitHub Release** only, not in `CHANGELOG.md`
  (matching common practice). Prereleases on `beta` are not annotated.

## Future
The model is compatible with richer `semantic-release` channels (e.g. additional
prerelease tracks) without changing the branch strategy.
