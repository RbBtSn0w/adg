# Contributing

Thanks for helping improve ADG! This project uses a two-branch model to keep
releases stable and the contribution flow predictable.

## Branch model

| Branch | Role | Who pushes | Released as |
| ------ | ---- | ---------- | ----------- |
| `main` | Stable release. Default/home branch. | Maintainers only, via release PR from `beta`. | Stable version |
| `beta` | Integration branch. Target for all contributions. | Contributors, via PR. | Prerelease (`-beta.N`) |

**All pull requests must target `beta`.** `main` is reserved for stable
releases and is not a destination for development work. PRs that target `main`
(other than the maintainer release PR from `beta`) are rejected automatically by
CI.

## Contributor workflow

1. **Fork** the repository.
2. Create a **feature branch** off `beta`:
   ```bash
   git switch beta && git pull
   git switch -c fix/your-change
   ```
3. Make your change. Keep commits focused and use
   [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `chore:`, `docs:` …) — the release tooling derives the
   version bump from commit messages.
4. Run the local checks:
   ```bash
   npm ci
   npm run typecheck
   npm run build
   npm test
   ```
5. Open a **Pull Request with base branch `beta`** and fill in the PR template.
6. Wait for CI and code review. A maintainer merges once both pass.

## What gets rejected

- PRs targeting `main` directly (CI fails with
  *"Pull requests must target the beta branch."*).
- Pushes directly to `main` or `beta` (branch protection requires a PR).

## Release flow (maintainers)

Releases are **not** cut on every PR merge. Changes accumulate on `beta` and ship
on a maintainer's schedule (weekly / per-milestone / per-feature-set).

```
Multiple PRs ─▶ merge into beta ─▶ test & validate
            ─▶ release PR: beta → main ─▶ stable release published
```

- Merging into `beta` publishes a **prerelease** (`x.y.z-beta.N`).
- Promoting `beta` → `main` publishes the **stable** release.

Both are handled by `semantic-release` (see `.releaserc.json` and
`.github/workflows/ci.yml`). See [docs/branching-and-release.md](docs/branching-and-release.md)
for the full process and repository protection setup.
