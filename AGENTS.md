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

## Telemetry

- **OpenTelemetry (OTel)**: For every new feature or requirement added, ensure you implement corresponding OpenTelemetry instrumentation (spans, events, or metrics) to maintain observability.
- **OTel CLI Compliance**: All CLI programs and external subprocess wrappers must strictly follow the official [Semantic conventions for CLI programs](https://opentelemetry.io/docs/specs/semconv/cli/cli-spans/):
  - Use `SpanKind.INTERNAL` for the CLI's own execution (callee spans) and `SpanKind.CLIENT` for subprocess calls (caller spans).
  - Span names must default to `{process.executable.name}` (e.g. `"git"`, `"claude"`) or documented low-cardinality values.
  - Correctly record all **Required** attributes: `process.executable.name`, `process.exit.code`, and `process.pid`.
  - Correctly record `error.type` on failure spans (when `process.exit.code !== 0`) as **Conditionally Required**.
- **Telemetry Privacy**: **All telemetry data must comply with privacy standards**—never log raw file paths, personally identifiable information (PII), or user secrets/tokens. Sanitization (e.g., `sanitizeArgs()`) is mandatory before collecting `process.command_args`.

## Do not

- Do not stage, commit, push, or open PRs unless explicitly asked.
- Do not edit release/CI config (`.releaserc.json`, `.github/workflows/*`),
  lockfiles, or branch-protection scripts without surfacing the risk first.
- Do not bypass branch protection or merge to `main` outside the documented
  `beta → main` release flow.
