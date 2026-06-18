# Vendored: skills CLI

This directory is a **fork (verbatim vendoring) of the `skills` CLI source**,
wrapped by `adg skills`.

| Field | Value |
|-------|-------|
| Upstream repo | https://github.com/vercel-labs/skills |
| npm package | `skills` (v1.5.11) |
| Vendored commit | `be0dd25b4a8665894a56f45ef582cc02ca802c39` |
| Vendored on | 2026-06-11 |
| What was copied | `src/` (excluding `*.test.ts`) and `ThirdPartyNoticeText.txt` |

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

These intentional deviations from upstream must be carried forward when
re-vendoring. Each is marked inline with an `ADG patch:` comment.

| File | Change | Why |
|------|--------|-----|
| `src/skill-lock.ts` → `getSkillLockPath()` | XDG global lock path `$XDG_STATE_HOME/skills/.skill-lock.json` → `$XDG_STATE_HOME/.agents/.skill-lock.json` | Keep the skills and plugins domains under one shared `.agents/` home in XDG mode, matching ADG's `globalPluginsDir()`. Upstream's `skills/` subpath split the root and scattered global state. See docs/agents-spec.md §1. |
| `src/agents.ts` → `universal` agent `globalSkillsDir` (+ new `agentsHome` const) | `$XDG_CONFIG_HOME/agents/skills` → `<$XDG_STATE_HOME or ~>/.agents/skills` | Same root principle. Upstream's universal *global* dir used XDG-**config**, splitting it from its own *project* dir (`.agents/skills`) and from the lock. Now all share `$XDG_STATE_HOME/.agents` (or `~/.agents`). See docs/agents-spec.md §1. |
| `src/blob.ts` → `fetchRepoTree` / `fetchTreeBranch` (+ `authMayHelp` on `BranchFetchResult`) | Retry authenticated on 401/403/404, not only on a rate-limit 403 | **Private-repo bug**: GitHub returns 404 to anonymous tree requests for private repos. Upstream only fell back to a token on rate limit, so private skills sources never used the token and always "failed to fetch tree". |
| `src/skill-lock.ts` → `getGitHubToken` warning text | "GitHub rate limit reached" → "GitHub authentication needed" | The resolver is now also used to reach private repos, not just to recover from a rate limit. |
| `src/update.ts` → `updateGlobalSkills` | Track `failedSources`; stop printing "All global skills are up to date" when a source could not be checked | The swallowed private-repo failure used to be masked by a false "up to date". Now surfaced, with a hint to set `GITHUB_TOKEN` / `gh auth login`, and counted in `failCount`. |
| `src/update.ts` → `SELF_CLI_ENTRY` (both global + project update paths) | Re-invoke `<src>/cli.ts` instead of the built `../bin/cli.mjs` | We vendor `src/` only — the built `bin/cli.mjs` upstream re-invokes for each update does not exist here, so **every** update failed with "CLI entrypoint not found". Our entry is the TS source run via Node type-stripping, same as `adg skills`. |
| `src/git.ts` → `createGitClient` | Add `unsafe: { allowUnsafeFilter: true }` to `simpleGit(...)` | simple-git ≥3.36 blocks `filter.*.smudge/clean` configs (RCE vector) and fails **every** clone with "Configuring filter.smudge is not permitted without enabling allowUnsafeFilter". The configs here set the LFS filter to EMPTY (disabling it), so opting in is safe and matches their intent. |
| `src/git.ts` → `import simpleGit from 'simple-git'` | Default → named import `import { simpleGit } from 'simple-git'` | The default import is not callable under ADG's strict root tsconfig (NodeNext + verbatimModuleSyntax, no esModuleInterop); the named export is. Needed for `git.ts` to typecheck when a test imports it (e.g. via `use.ts`). |
| `src/git.ts` → `createGitClient` env | Pass env via `.env({...})` instead of as a `simpleGit(...)` constructor option | **Latent runtime bug**: simple-git's factory only reads `baseDir`/`maxConcurrentProcesses`/`config`/`trimmed`/plugins from the options object and silently drops `env`, so `GIT_TERMINAL_PROMPT`/`GIT_LFS_SKIP_SMUDGE`/`GIT_SSH_COMMAND` never reached the spawned git (it inherited the full parent env). `.env(object)` is the documented API and sets the executor env actually used at spawn. |
| `src/skills.ts` → `parseSkillMd` | Narrow `data.metadata` (frontmatter `unknown`) to `Record<string, unknown> \| undefined` before reading `.internal` / returning it | Behavior-preserving type fix so `skills.ts` typechecks under ADG's strict root tsconfig when reached via `use.ts`/tests. |
| `src/update.ts` → both `spawnSync` self-CLI re-invokes (+ new `src/self-cli.ts`) | Forward `process.execArgv` (`[...process.execArgv, cliEntry, ...]`) via a shared `selfCliArgv()` helper | The re-invoked `cli.ts` child must inherit Node flags (e.g. `--experimental-strip-types`) to run TypeScript directly on Node 22.6–23.5, else it throws a `SyntaxError`. `selfCliArgv` lives in the dependency-free `self-cli.ts` so a regression test can import it without pulling `update.ts` → `remove.ts` → `detect-agent.ts` (same standalone rationale as `git-tree.ts`). |
| `package.json` → `@vercel/detect-agent` dependency (not a vendored-source change) | `^0.1.0` → `^1.2.3` | `src/detect-agent.ts` (upstream, unpatched) imports `AgentResult` and expects `determineAgent(): Promise<AgentResult>` (object API). The stale `0.1.0` pin only exported `determineAgent(): Promise<string \| false>` and no `AgentResult`, which broke typecheck and left `cachedResult.isAgent` always `undefined` at runtime — agent auto-detection (non-interactive mode in `add`/`sync`/`remove`/`find`/`cli`) silently never fired. The `1.x` line restores the API the fork targets, so `detect-agent.ts` needs **no** local patch. Keep this dependency on `1.x` across re-vendoring. |
| `src/git-tree.ts` (**new ADG file**) + `src/add.ts` clone-fallback branch | github source that falls back to a `git clone` now records the git **tree SHA** (`git rev-parse HEAD:<folder>`), not a sha256 content hash | Install and update must use ONE hash scheme per source. Update-check always uses the git tree SHA; the old clone fallback stored a sha256 content hash, so those skills were re-flagged on **every** update (a collection repo appeared to "fully update" each run). `git-tree.ts` is standalone (uses `child_process`, no simple-git) so it typechecks under ADG's strict tsconfig when a test imports it. |
| `src/update.ts` → `updateGlobalSkills` self-heal | A github entry whose stored hash isn't a 40-hex tree SHA (legacy clone-fallback) is normalized to the current tree SHA and NOT flagged; lock rewritten once | Heals locks written before the fix above without a version bump / lock wipe, and stops the perpetual false "update". |
