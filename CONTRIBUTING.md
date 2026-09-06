# Contributing

Thanks for helping improve ADG! This project uses a two-branch model to keep
releases stable and the contribution flow predictable.

## Branch model

| Branch | Role | Who pushes | Released as |
| ------ | ---- | ---------- | ----------- |
| `main` | Stable release. Default/home branch. | Automated release PR from `develop` (or maintainers). | Stable version |
| `develop` | Integration branch. Target for all contributions. | Contributors, via PR. | Prerelease (`-beta.N`) |

**All pull requests must target `develop`.** `main` is reserved for stable
releases and is not a destination for development work. PRs that target `main`
(other than the release promotion PR from `develop`) are rejected automatically by
CI.

## Contributor workflow

1. **Fork** the repository.
2. Create a **feature branch** off `develop`:
   ```bash
   git switch develop && git pull
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
5. Open a **Pull Request with base branch `develop`** and fill in the PR template.
6. Wait for CI and code review. A maintainer merges once both pass.

CI runs the full check sequence (`npm ci`, dependency/audit checks, typecheck,
build, and tests) on Ubuntu and Windows with the current three Node.js release
lines: Node 24, 25, and 26. The Windows lanes are required guards for
path-separator and shell-quoting behavior.

## Test conventions

- **Name test files after the module or behavior under test** (`adapters.test.ts`,
  `paths.test.ts`, `render.test.ts`), never after the PR, commit, or issue that
  introduced them. PR/commit-scoped names (e.g. `pr1-cr-fixes.test.ts`) lose all
  meaning over time and scatter a module's coverage across files.
- Put a **regression case in the behavior file it belongs to**, tagged with a
  short `// (Regression: <PR/issue>)` comment, rather than in a dedicated
  per-PR file.
- `test/test-conventions.test.ts` enforces the naming rule in CI; runtime
  dependency drift between the root and `vendor/skills` is enforced by
  `npm run check:vendor-deps`.
- The shared fixtures (`tmp`, `baseManifest`, `scaffoldSource`) live in
  `test/helpers.ts` — reuse them instead of re-declaring per file.

## What gets rejected

- PRs targeting `main` directly (CI fails with
  *"Pull requests must target the develop branch."*).
- Pushes directly to `main` or `develop` (branch protection requires a PR).

## Release flow

Releases are automated. Changes accumulate on `develop` and ship via scheduled
Friday release PRs or maintainer workflow dispatch.

```
Multiple PRs ─▶ merge into develop ─▶ test & validate (publishes -beta.N)
             ─▶ release PR: develop → main ─▶ auto-merge on green CI ─▶ stable release published
```

- Merging into `develop` publishes a **prerelease** (`x.y.z-beta.N`).
- Promoting `develop` → `main` publishes the **stable** release.

Both are handled by `semantic-release` (see `.releaserc.json` and
`.github/workflows/ci.yml`). See [docs/branching-and-release.md](docs/branching-and-release.md)
for the full process and repository protection setup.
