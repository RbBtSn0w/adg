# Branching and release

ADG uses `develop` as the integration branch and `main` as the stable release
branch. Feature and fix pull requests always target `develop`; the only pull
request allowed to target `main` is the release promotion from `develop`.

## Contribution flow

1. Branch from the latest `develop`.
2. Open a pull request back to `develop`.
3. Pass the repository checks and review.
4. Merge through branch protection; never push directly to `develop` or `main`.

Merges to `develop` are published by semantic-release under the `beta` npm
dist-tag (prereleases as `x.y.z-beta.N`).

## Automated Weekly Stable Release

Every Friday at 15:00 Beijing time (UTC+8 / 07:00 UTC), a scheduled automation workflow
(`.github/workflows/scheduled-release-pr.yml`):

1. Checks if `develop` has new commits ahead of `main`.
2. Automatically opens a `develop -> main` release promotion PR.
3. Enables native GitHub `auto-merge`.
4. Once all CI checks (test matrix, audits, smoke tests) pass and there are no conflicts or blockers, GitHub automatically merges the PR into `main`.
5. Merging to `main` triggers `semantic-release` to cut a stable release (`latest` dist-tag).

## PR Dev Preview Releases

Each pull request targeting `develop` triggers automated dev preview packaging:

- Published under the `next` dist-tag on npm and GitHub Packages.
- Formatted as `<BASE>-dev.pr<PR_NUM>.<SHORT_SHA>`.
- The CI bot posts verification instructions directly on the PR with `npx`, `adg update --tag <version>`, or `adg update --dev`.

## Back-merge after a stable release

The release commit created on `main` must be merged back into `develop` so both
branches share the same release ancestry. The `Sync main to develop` workflow opens
a `main -> develop` pull request after successful main CI:

- A conflict-free pull request is merged automatically with a merge commit.
- A conflicting pull request receives `manual-sync-needed` and must be resolved
  by a maintainer before further promotion work.
- Resolve version and changelog conflicts in favor of the stable `main` release
  commit while preserving subsequent integration changes from `develop`.

The workflow never pushes directly to a protected branch. An open
`manual-sync-needed` pull request is an operational action item, not a successful
sync.

## Local release checks

Run the same checks used by CI before opening a pull request:

```bash
npm ci
npm run check:vendor-deps
npm run check:vendor-upstream
npm run audit:prod
npm run check:docs
npm run typecheck
npm run build
npm test
npm run check:package-smoke
```

Release automation is defined in `.github/workflows/ci.yml` and
`.releaserc.json`. Optional Homebrew publication only runs for stable releases
when the release-bot GitHub App is configured.
