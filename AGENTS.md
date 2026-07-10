# AGENTS.md

Guidance for AI agents (and humans) contributing to this repository. See
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/branching-and-release.md](docs/branching-and-release.md) for the full
process.

## Product and architecture boundaries

- **ADG means Agent Directory Group.** It is a directory packaging and
  projection layer for multiple agent runtimes, not a runtime-state
  orchestrator. Keep new abstractions centered on source ingestion, directory
  layout, reproducible materialization, and runtime-specific projections.
- ADG owns canonical authoring artifacts, source snapshots, the lock state for
  its managed store, generated runtime projections, and health diagnostics for
  those projections. Agent runtimes own their complete marketplace registry,
  activation policy, private caches, and execution lifecycle.
- `.agents/.plugin.json` is the authoring source of truth.
  `.plugin-lock.json` is authoritative only for the ADG-managed directory
  lifecycle. `marketplace.json`, runtime manifests, installed directories, and
  agent registries are generated or observed views; they must not become a
  second ADG control plane.
- Preserve each runtime's native identity and discovery model. Do not invent a
  shared ADG marketplace namespace or a universal desired-state model for
  Codex, Claude, and Antigravity. Store-scoped runtime keys are allowed only
  when needed to isolate otherwise-colliding directory projections.
- An adapter must project through the runtime's canonical discovery root and
  retain enough observed identity to diagnose duplicate ADG projections,
  marketplace aliases, and root mismatches. `status` remains read-only;
  mutating verbs may repair only artifacts proven to be ADG-managed. Report
  foreign runtime state instead of deleting or adopting it.
- Runtime-specific exports may coexist in one ADG store, but each adapter must
  expose only its own canonical export/root. Never remove another runtime's
  valid projection to work around a discovery bug.
- Every managed effective installation must remain reproducible from an ADG
  source snapshot plus the lock selection. Do not use the effective
  installation as its own source or silently continue when the snapshot is
  unavailable.

See [docs/agents-spec.md](docs/agents-spec.md) for the canonical authoring and
projection model and [docs/hooks-strategy.md](docs/hooks-strategy.md) for the
standards-first adapter philosophy.

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
  - Correctly record all **Required** attributes: `process.executable.name` and `process.exit.code`.
  - Record `process.pid` when available (Recommended).
  - Correctly record `error.type` on failure spans (when `process.exit.code !== 0`) as **Conditionally Required**.
  - Do NOT collect `process.executable.path` — it is always PII and provides no analytical value after sanitization.
- **Telemetry Privacy**: **All telemetry data must comply with privacy standards**—never log raw file paths, personally identifiable information (PII), or user secrets/tokens. Sanitization (e.g., `sanitizeArgs()`) is mandatory before collecting `process.command_args`.

## Do not

- Do not stage, commit, push, or open PRs unless explicitly asked.
- Do not edit release/CI config (`.releaserc.json`, `.github/workflows/*`),
  lockfiles, or branch-protection scripts without surfacing the risk first.
- Do not bypass branch protection or merge to `main` outside the documented
  `beta → main` release flow.
