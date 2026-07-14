# Branching and release

ADG uses `beta` as the integration branch and `main` as the stable release
branch. Feature and fix pull requests always target `beta`; the only pull
request allowed to target `main` is the maintainer promotion from `beta`.

## Contribution flow

1. Branch from the latest `beta`.
2. Open a pull request back to `beta`.
3. Pass the repository checks and review.
4. Merge through branch protection; never push directly to `beta` or `main`.

Merges to `beta` are published by semantic-release under the `beta` npm
dist-tag. Maintainers promote a tested release set with a `beta -> main` pull
request; merging that pull request publishes the stable `latest` dist-tag.

## Back-merge after a stable release

The release commit created on `main` must be merged back into `beta` so both
branches share the same release ancestry. The `Sync main to beta` workflow opens
a `main -> beta` pull request after successful main CI:

- A conflict-free pull request is merged automatically with a merge commit.
- A conflicting pull request receives `manual-sync-needed` and must be resolved
  by a maintainer before further promotion work.
- Resolve version and changelog conflicts in favor of the stable `main` release
  commit while preserving subsequent integration changes from `beta`.

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
