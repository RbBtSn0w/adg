# Contributing

Contributions use short-lived branches and reviewed squash PRs to `main`, the
only integration trunk. Preserve Conventional Commit title/body and breaking
change declarations. Direct pushes to main are not part of the contribution flow.

## Contributor workflow

1. **Fork** the repository.
2. Create a **feature branch** off `main`:
   ```bash
   git switch main && git pull
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
5. Open a **Pull Request with base branch `main`** and fill in the PR template.
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

## Release flow

CI verifies contributions without publishing. The default-off scheduled/manual
workflow publishes stable packages from main only, after repeating exact-candidate
verification. See [branching and release](docs/branching-and-release.md) for
artifact checks, activation requirements, and partial-publication recovery.
