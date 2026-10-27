# Vendored: skills CLI

This directory is a **vendored fork of the `skills` CLI source**,
wrapped by `adg skills`.

| Field | Value |
|-------|-------|
| Upstream repo | https://github.com/vercel-labs/skills |
| npm package | `skills` (v1.7.4) |
| Vendored commit | `31b74517250aec1d2a4be7801fa70b08535ad0e5` (tag `v1.7.4`) |
| Vendored on | 2026-10-27 |
| Previous vendoring | `c1755dd49618b02a4181495ee7404eec3d744c81` (v1.5.23), 2026-09-03 |
| What was copied | `src/` (excluding `*.test.ts`) and `ThirdPartyNoticeText.txt` |

## Re-sync notes (v1.5.23 → v1.7.4, 2026-10-27)

Three-way merge using the original v1.5.23 source (`c1755dd`) as the base,
ADG's current vendored source as ours, and the latest upstream release v1.7.4
(`31b7451`) as theirs. The previous re-sync notes and patch inventory below
remain part of the upgrade contract; replacing entire overlapping files with
the old ADG implementation would discard upstream fixes again.

- Carried upstream JSON install output, commit-SHA installs, Azure Repos URL
  parsing, BOM-prefixed frontmatter, Notion skill sources, source-based removal,
  relocation-aware updates, and project update hash checks.
- Carried dependency sync's direct/optional/peer dependencies, package `skills`
  fields (`npm:` and Git sources), workspace recursion, include/exclude filters,
  dry runs, ownership-aware cleanup, symlink installation, and saved agents.
  `experimental_sync` remains the advertised command; `sync` is an alias.
- Merged agent roots and added fx/Sarvam Code support. Codex follows upstream's
  move to `~/.agents/skills`; the ADG universal agent and global lock retain their
  existing XDG-state contract. No installed directories are moved by this source
  upgrade itself.
- Reapplied ADG's Git environment sanitization, fixed SSH BatchMode command,
  simple-git 4 compatibility, private-repository auth retries, shared OTel
  provider, bounded telemetry fields, ADG self-CLI entrypoint/Node flags,
  transient progress output, and legacy GitHub SHA-256 lock healing.
- `add.ts` was reconciled against the new shared install primitives rather than
  preserving its obsolete implementation. ADG's installed-skill badges/grouped
  picker, remote-root single-file installation/hash, and GitHub clone tree-SHA
  fallback now live alongside the new programmatic install path and JSON mode.
- The new `ntn` subprocess uses ADG's shared CLIENT-span annotation, preserving
  exit/error attributes while excluding raw page identifiers, output, and paths.
  The security audit endpoint follows upstream's new `skills.sh/tele/audit` URL;
  upstream raw event telemetry remains replaced by ADG OTel.
- Replaced `Map.groupBy` locally with equivalent map accumulation to preserve
  ADG's ES2023 TypeScript target. Runtime dependency floors are unchanged; the
  root dependency manifest and lockfile need no update.
- Kept upstream's path-level discovery deduplication alongside ADG's parser and
  lock filtering: same-name skills at distinct locations remain visible to
  relocation checks, while repeated scans of the same location do not create
  false ambiguity. The remote-root single-file hash is shared by install and
  update so an unchanged root skill is not reinstalled on every update.

### Review follow-up and historical patch audit

Reviewing the original patches as well as the current baseline uncovered two
older regressions from the v1.5.23 re-sync: #86's transient TTY progress helpers
had been removed, and #60's missing-entrypoint span helper remained defined but
was never called. Both are restored, including well-known updates. A mixed
result now also counts a failed source when another skill updates successfully.
`test/skills-update.test.ts` covers these observable contracts.

Running the previously excluded upstream tests also exposed retained old code
that was not an ADG policy: missing blob discovery prefixes/depth, omitted
explicit-ref snapshot bypass, missing early `ext::` rejection, and loose array
metadata parsing. These now follow upstream. Disk discovery/frontmatter parsing
is byte-identical to v1.7.4, including record-only metadata, parse diagnostics,
three-level container walking, and path deduplication.

The remaining historical contracts were checked against their owning code and
regression coverage: XDG `.agents` roots, lazy authenticated private-tree retries,
sanitized Git environments and fixed SSH BatchMode, simple-git 4's allowlist,
ADG self-invocation/Node flags, shared bounded OTel, GitHub tree-SHA fallback and
legacy hash healing, direct/well-known metadata, Eve placement, restricted
interactive agent launches, installed-skill badges, and the remote-root
single-file installation boundary. Anonymous branch fallback now finishes
before requesting credentials; 401/403/404 auth retries are all covered.

### Upstream test exclusions and fixture adaptations

The old 21-file exclusion list is replaced by one excluded artifact-build test
file and ten exact, anchored test names. All other upstream assertions run.
The runner does not exclude a whole behavior suite to accommodate one mismatch.

| Excluded upstream assertion(s) | Why ADG differs | Replacement evidence |
| --- | --- | --- |
| `tests/dist.test.ts` (one assertion) | Builds the upstream obuild artifact; ADG builds the enclosing CLI and shared root modules | `npm run build`, `npm run check:package-smoke` install and run the actual ADG artifact |
| `git clone fallbacks` / `allows the hard-coded LFS filter overrides required for clone` | The assertion also requires enabling every inherited command-capable helper; ADG permits only its fixed filter/SSH configuration and sanitizes inherited environment hooks | `test/vendor-skills-git.test.ts` clones with real simple-git 4, inherited hook/config injection, and a pinned commit |
| `getGitHubToken` / `does not extract credentials from external tools` | ADG retains its one-time warning and explicit `gh auth token` fallback | `test/skills-auth.test.ts` stubs the subprocess, verifies warning count and privacy-safe CLIENT spans; no real credential is read |
| `fetchRepoTree lazy auth fallback` / `does not invoke the token resolver on a non-rate-limit 403` | ADG retries anonymous permission-denied 403 responses as well as 401/404 | `test/skills-private-repo.test.ts` checks each status, unavailable credentials, and anonymous branch fallback before auth |
| `Pi agent support` / `accepts pi as a valid --agent for skills use` | Pi remains installable; ADG's interactive launcher supports only its explicit launch map | `test/use.test.ts` rejects Pi/unsupported launch targets and tests supported agent subprocesses |
| `private repository installs` / `installs from another Git host and preserves opted-in non-GitHub telemetry`; all three `direct telemetry endpoints` assertions | ADG emits bounded OTel events instead of raw source/query telemetry requests. The security-audit request remains independent of event opt-outs, matching the existing ADG contract | `test/skills-telemetry.test.ts` verifies the new audit endpoint, opt-outs, shared in-memory spans, bounded fields, and zero raw event HTTP requests |
| `root-level disk install (issue #1603)` / full-directory installation; `root-level lock hash covers the whole directory (issue #1603)` / supporting-file hash changes | ADG retains `SKILL.md`-only installation for a remote repository-root skill, avoiding copying an entire repository. Supporting files should live in a dedicated skill directory | `test/skills-add.test.ts` exercises the real ADG CLI, verifies the single-file boundary and stable unchanged updates |

The temporary upstream test checkout receives explicit fixture adaptations:
three global-lock fixtures use ADG's `.agents` path; help expects the retained
OpenClaw `use` warning; `use --agent` tests use ADG's single-value/repeated-flag
syntax and diagnostic label; the Git mock exposes the named `simpleGit` export
and Node's real `execFile` custom-promisifier shape. The original outcome
assertions remain. Exact replacement counts fail the check if upstream fixtures
drift, so these adaptations cannot silently disappear during another upgrade.

### Validation (2026-10-27)

Verified locally on macOS with Node v25.8.2:

- `npm ci`, `npm run typecheck`, `npm run build`, and
  `npm run check:vendor-deps` passed with the unchanged root lockfile.
- `npm test`: 641 passed, zero failures or skips. The OTLP transport test used
  a temporary loopback server; no production telemetry was sent.
- `npm run check:vendor-upstream`: 967 passed, ten exact assertions skipped;
  only the upstream artifact-build file is excluded. The table above records
  every difference and its replacement coverage.
- `npm run check:docs`, `npm run check:test-isolation`, and
  `npm run check:package-smoke` passed. The packed package was installed in a
  temporary directory and both CLI domains were exercised.
- Source inventory: all 37 upstream production TypeScript files are present;
  22 remain byte-identical, 15 carry ADG integration patches, and the two
  existing ADG-only helpers (`git-tree.ts`, `self-cli.ts`) remain present.

No Windows CI, live Notion authentication/download, or real installed-skill
migration was exercised. Root dependency/release configuration and lockfiles
were not changed; no package was published.

`npm audit --omit=dev --json` reported zero production vulnerabilities. The
full `npm ci` audit still reports five existing development-tool advisories
(two moderate, three high); this upgrade does not change their dependency lock.

### Historical re-sync notes (v1.5.14 → v1.5.23, 2026-09-03)

3-way merge (base `2adcfe5`, ours = prior vendoring + ADG patches, theirs `c1755dd`).
The first pass accidentally retained old implementations in several overlapping
files. This re-sync restores the upstream archive/direct-download flow, well-known
digest/update flow, expanded discovery depth and agents, GitHub Enterprise auth
paths, Git transport hardening, and lock/update metadata. ADG-owned security and
runtime patches were then re-applied manually. The upstream package floors now
require `@clack/prompts` 1.2.0, `simple-git` 3.36.0, and `tar` 7.5.20.

The previous merge notes are retained below as the patch history.

3-way merge (base `be0dd25`, ours = prior vendoring + ADG patches, theirs `2adcfe5`).
Upstream dependencies were unchanged. Resolution map:

- **Auto-merged clean** (upstream + ADG changes disjoint): `agents.ts`, `blob.ts`, `cli.ts`.
- **Took upstream** (ADG unmodified): `find.ts`, `installer.ts`, `local-lock.ts`, `remove.ts`, `types.ts`.
- **Kept ADG** (upstream unmodified): `telemetry.ts`, `git.ts`, `install.ts`, `skill-lock.ts`,
  `skills.ts`, `source-parser.ts`, `use.ts`, `providers/wellknown.ts`, `git-tree.ts`, `self-cli.ts`.
- **Manual conflict resolutions** (2):
  - `add.ts` — **openclaw source guard dropped to follow upstream.** 1.5.14 removed the
    "block `openclaw/*` sources unless `--dangerously-accept-openclaw-risks`" gate from `add`
    and reconceived `openclaw` as a first-class *agent*. We took upstream (removed the guard,
    the `AddOptions.dangerouslyAcceptOpenclawRisks` field, and its arg parsing). The `use`
    command keeps its own independent openclaw guard (upstream `use.ts` still has it).
  - `update.ts` — carried upstream's new `--subagent` (Eve) forwarding **into** ADG's
    `SELF_CLI_ENTRY`/OTel-CLIENT-span spawn: `subagentArgs` is now spliced into the
    `adg skills add … --skill <name> [--subagent …] -y` args on the project-update path.
- **New upstream feature carried in full**: Eve subagents (`eve` agent, `--subagent` install
  flag, subagent-aware project update) and `find --owner`.

## License — MIT

The upstream `skills` is **MIT-licensed**, declared in two places:

- the repository `README.md` (`## License` → `MIT`), and
- the npm package `package.json` (`"license": "MIT"`, retained here).

GitHub's API reports `license: null` only because the upstream repo ships no
*standalone LICENSE file* (the API's detector keys on a LICENSE file, not a
README section). This is a best-practice gap, not a missing grant — MIT use,
modification and redistribution are permitted provided the copyright and
permission notice are retained.

To satisfy MIT's notice requirement for this redistribution, this directory
includes a reconstructed [`LICENSE`](LICENSE) (standard MIT text + attribution
to the upstream authors) and the upstream `ThirdPartyNoticeText.txt`. The
upstream did not provide an explicit copyright line; attribution is to
Vercel Labs and the `skills` contributors.

Nice-to-have (not blocking): ask upstream to add a standalone `LICENSE` file so
the grant is unambiguous and machine-detectable.

Do not edit files under `src/` casually: keeping them close to upstream eases a
future re-sync or clean-room replacement. ADG-side glue lives outside this
directory.

## Local patches (re-apply after any re-sync)

These integration contracts must be carried forward when re-vendoring. Some
are now provided directly by upstream; retained local deviations are marked
inline with an `ADG patch:` comment where practical.

| File | Change | Why |
|------|--------|-----|
| `src/skill-lock.ts` → `getSkillLockPath()` | XDG global lock path `$XDG_STATE_HOME/skills/.skill-lock.json` → `$XDG_STATE_HOME/.agents/.skill-lock.json` | Keep the skills and plugins domains under one shared `.agents/` home in XDG mode, matching ADG's `globalPluginsDir()`. Upstream's `skills/` subpath split the root and scattered global state. See docs/agents-spec.md §1. |
| `src/agents.ts` → `universal` agent `globalSkillsDir` (+ new `agentsHome` const) | `$XDG_CONFIG_HOME/agents/skills` → `<$XDG_STATE_HOME or ~>/.agents/skills` | Same root principle. Upstream's universal *global* dir used XDG-**config**, splitting it from its own *project* dir (`.agents/skills`) and from the lock. Now all share `$XDG_STATE_HOME/.agents` (or `~/.agents`). See docs/agents-spec.md §1. |
| `src/blob.ts` → `fetchRepoTree` / `fetchTreeBranch` (+ `authMayHelp` on `BranchFetchResult`) | Retry authenticated on 401/403/404, not only on a rate-limit 403 | **Private-repo bug**: GitHub returns 404 to anonymous tree requests for private repos. Upstream only fell back to a token on rate limit, so private skills sources never used the token and always "failed to fetch tree". |
| `src/skill-lock.ts` → `getGitHubToken` warning text | "GitHub rate limit reached" → "GitHub authentication needed" | The resolver is now also used to reach private repos, not just to recover from a rate limit. |
| `src/update.ts` → `updateGlobalSkills` | Track `failedSources`; stop printing "All global skills are up to date" when a source could not be checked | The swallowed private-repo failure used to be masked by a false "up to date". Now surfaced, with a hint to set `GITHUB_TOKEN` / `gh auth login`, and counted in `failCount`. |
| `src/update.ts` → `SELF_CLI_ENTRY` (both global + project update paths) | Re-invoke ADG binary `bin/adg.ts` / `bin/adg.js` instead of `cli.ts` / `cli.js` | Unifies execution under the main ADG product logic (`adg skills add`), keeping telemetry and wrapper context active. |
| `src/telemetry.ts` → `getTracer` | SERVICE_NAME `"adg-skills"` $\rightarrow$ `"adg"`, plus `domain: "skills"` span attribute and export `getTracer` | Unifies the telemetry tracking under the single complete `adg` product service name while keeping domain categorization, and allows `update.ts` to wrap subprocesses in CLIENT spans. |
| `src/telemetry.ts` → shared provider and bounded attributes | Reuse ADG's root tracer/provider and replace raw source, skill, agent-list, and query fields with bounded type/count/scope dimensions | Prevent duplicate SDK shutdown paths and keep vendored skills telemetry inside ADG's privacy contract. |
| `src/git.ts` → `createGitClient` | Add `unsafe: { allowUnsafeFilter: true }` to `simpleGit(...)` | simple-git ≥3.36 blocks `filter.*.smudge/clean` configs (RCE vector) and fails **every** clone with "Configuring filter.smudge is not permitted without enabling allowUnsafeFilter". The configs here set the LFS filter to EMPTY (disabling it), so opting in is safe and matches their intent. |
| `src/git.ts` → `import simpleGit from 'simple-git'` | Default → named import `import { simpleGit } from 'simple-git'` | The default import is not callable under ADG's strict root tsconfig (NodeNext + verbatimModuleSyntax, no esModuleInterop); the named export is. Needed for `git.ts` to typecheck when a test imports it (e.g. via `use.ts`). |
| `src/git.ts` → `createGitClient` env | Pass env via `.env({...})` instead of as a `simpleGit(...)` constructor option | **Latent runtime bug**: simple-git's factory only reads `baseDir`/`maxConcurrentProcesses`/`config`/`trimmed`/plugins from the options object and silently drops `env`, so `GIT_TERMINAL_PROMPT`/`GIT_LFS_SKIP_SMUDGE`/`GIT_SSH_COMMAND` never reached the spawned git (it inherited the full parent env). `.env(object)` is the documented API and sets the executor env actually used at spawn. |
| `src/git.ts` → `createGitClient` inherited env sanitization | Case-insensitively remove executable/redirecting Git environment hooks and `GIT_CONFIG_PARAMETERS` before constructing the clone client; allow only ADG's fixed SSH BatchMode override | IDEs can inject `GIT_ASKPASS`, `GIT_PAGER`, config overrides, and similar helpers even for users with no GitHub account. simple-git >=3.36 rejects known hooks before an anonymous public clone can run, while mixed-case Windows keys or config parameters could bypass exact-key deletion. Sanitizing them preserves non-interactive public installs without opting arbitrary parent-process commands into execution. |
| `src/skills.ts` → `parseSkillMd` (now upstream-supplied) | Narrow metadata to a non-array record before reading `.internal` or returning it | Upstream's `isRecord` now satisfies ADG's strict type contract and rejects array metadata; the old loose local cast is no longer needed. |
| `src/update.ts` → both `spawnSync` self-CLI re-invokes (+ new `src/self-cli.ts`) | Forward `process.execArgv`, call `skills add` instead of `add`, and wrap in OpenTelemetry CLIENT spans | The child process runs `adg skills add` inside the spawned Node context, ensuring type-stripping flags inherit properly, and OTel spans capture subprocess execution metadata. |
| `package.json` → `@vercel/detect-agent` dependency (not a vendored-source change) | `^0.1.0` → `^1.2.3` | `src/detect-agent.ts` (upstream, unpatched) imports `AgentResult` and expects `determineAgent(): Promise<AgentResult>` (object API). The stale `0.1.0` pin only exported `determineAgent(): Promise<string \| false>` and no `AgentResult`, which broke typecheck and left `cachedResult.isAgent` always `undefined` at runtime — agent auto-detection (non-interactive mode in `add`/`sync`/`remove`/`find`/`cli`) silently never fired. The `1.x` line restores the API the fork targets, so `detect-agent.ts` needs **no** local patch. Keep this dependency on `1.x` across re-vendoring. |
| `src/git-tree.ts` (**new ADG file**) + `src/add.ts` clone-fallback branch | github source that falls back to a `git clone` now records the git **tree SHA** (`git rev-parse HEAD:<folder>`), not a sha256 content hash | Install and update must use ONE hash scheme per source. Update-check always uses the git tree SHA; the old clone fallback stored a sha256 content hash, so those skills were re-flagged on **every** update (a collection repo appeared to "fully update" each run). `git-tree.ts` is standalone (uses `child_process`, no simple-git) so it typechecks under ADG's strict tsconfig when a test imports it. |
| `src/add.ts` → direct-download and well-known fallback | Route `download` sources through `downloadSource()` and fall back from empty well-known discovery to raw `SKILL.md`/archive download | `source-parser.ts` already classified these URLs, but the installer previously fell through to `cloneRepo()`, making the new source type unusable. |
| `src/add.ts`, `src/skill-lock.ts`, `src/local-lock.ts`, `src/update.ts` → well-known metadata | Persist the canonical base URL and content digest, then use them for global/project update checks | Without the digest metadata, well-known skills could install but could not participate in the upstream update lifecycle. |
| `src/skills.ts` → discovery depth and agent containers | Restore upstream three-level known-container discovery and current agent directories while retaining ADG path/lock filtering | Prevents nested catalog skills and newly supported agent locations from disappearing during synchronization. |
| `src/cli.ts`, `src/add.ts` → help and argument errors | Restore side-effect-free subcommand help and explicit option parse errors; retain ADG-specific OpenClaw help/security behavior | Keeps CLI behavior predictable without reintroducing upstream's removed OpenClaw execution warning policy. |
| `src/git-tree.ts` → `gitTreeShaForFolder` | Route the ADG-added `git rev-parse` subprocess through the root OTel CLIENT-span runner | Keeps the local fallback compliant with ADG's CLI semantic-convention policy without duplicating instrumentation inside the vendored fork. |
| `src/skill-lock.ts`, `src/update.ts`, `src/use.ts` | Route GitHub auth, self-update, and interactive agent subprocesses through the root OTel CLIENT-span runner | Enforces required exit/error attributes and privacy-safe command arguments consistently across the vendored CLI. |
| `src/skill-lock.ts` → `getGitHubToken` auth warning | Prefix the one-shot stderr warning with `\r\x1b[K` on a TTY | The warning lands on the same physical terminal line as `update.ts`'s transient stdout status line, which carries no trailing newline — without rewinding, the two are rendered concatenated. |
| `src/update.ts` → `updateGlobalSkills` per-source status line | Drop the trailing `\n` from the transient "Checking skills from source" line on a TTY (plain line off a TTY); gate the paired `\r\x1b[K` cleanup on TTY | The line opened with `\r` + `\x1b[K`, clearly intended to overwrite in place, but ended with `\n` — so each source **accumulated** a permanent line and the cleanup ran against an already-blank line (a no-op). Off a TTY the escapes were pure noise in CI logs. |
| `src/update.ts` → `updateGlobalSkills` self-heal | A GitHub entry with a legacy 64-hex SHA-256 content hash is normalized to the current tree SHA and NOT flagged; lock rewritten once | Heals locks written before the fix above without a version bump / lock wipe, and stops the perpetual false "update". Other hash shapes are still compared normally. |
| `src/add.ts` → shared install/hash primitives | Preserve remote-root `SKILL.md`-only installs and matching single-file content hashes in both interactive and programmatic installs | Carries ADG's existing root-skill boundary through upstream's install refactor. |
| `src/git.ts` → simple-git 4 options and SHA fallback | Keep the explicit environment allowlist, sanitized environment and fixed SSH command in the new fetch-by-commit path | Root uses simple-git 4; the upstream 3.x environment configuration cannot safely replace ADG's wrapper. |
| `src/notion-test.ts` → `runNtnApi` | Add a CLIENT span through the shared tracer and `annotateSubprocess`, including launch/exit/signal/timeout/output-limit outcomes | New external commands must obey the same CLI semantic conventions and privacy contract as existing Git and agent wrappers. |
| `src/sync.ts` → conflict grouping | Replace `Map.groupBy` with a typed map loop | Preserve ADG's ES2023 compile contract without changing the upstream grouping behavior. |
