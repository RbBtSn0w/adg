## [0.4.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.3...0.4.0-beta.4) (2026-06-25)

### Added

* **hooks:** cross-agent hooks compatibility + universal hooks DSL ([#33](https://github.com/RbBtSn0w/adg/issues/33)) ([8c0d1d1](https://github.com/RbBtSn0w/adg/commit/8c0d1d1c1e5fa50154f55a390195106281a0aa3b))

## [0.4.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.2...0.4.0-beta.3) (2026-06-25)

### Added

* **plugins:** guide scope for mutating verbs and guard the home==global trap ([#31](https://github.com/RbBtSn0w/adg/issues/31)) ([433d95b](https://github.com/RbBtSn0w/adg/commit/433d95b7fbfc98d05606cc9e4ec11d2ba6df8868))

## [0.4.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.4.0-beta.1...0.4.0-beta.2) (2026-06-25)

### Fixed

* **release:** add release rules for refactor type to trigger patch releases ([973ccda](https://github.com/RbBtSn0w/adg/commit/973ccda44369d456c65249b22a1f1ac23c1f18fc))

### Changed

* decompose bin/adg.ts, memoize CLI probe, dedup agent skips, alias marketplace upgrade ([#26](https://github.com/RbBtSn0w/adg/issues/26)) ([#29](https://github.com/RbBtSn0w/adg/issues/29)) ([a93f643](https://github.com/RbBtSn0w/adg/commit/a93f6431793e1c546f396660eeb776adb007889a))
* remove asc and github-cr plugin files and update .gitignore ([e3b0a7a](https://github.com/RbBtSn0w/adg/commit/e3b0a7a78a75ce5ced17439a73c4b70c09705a3c))

## [0.4.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.3.0...0.4.0-beta.1) (2026-06-23)

### Added

* **plugins:** add unlink/sync/status verbs and fix antigravity residual ([#27](https://github.com/RbBtSn0w/adg/issues/27)) ([c47e598](https://github.com/RbBtSn0w/adg/commit/c47e5984fef2c78cf4eeef5eab2612aa5bf899b2))

## [0.3.0](https://github.com/RbBtSn0w/adg/compare/0.2.1...0.3.0) (2026-06-22)

### Added

* add support for Antigravity adapter and enhance agent detection ([#10](https://github.com/RbBtSn0w/adg/issues/10)) ([91d0a63](https://github.com/RbBtSn0w/adg/commit/91d0a6374f5dc25281667e306062bebf0fb08903))
* enhance plugin agent listing and error messaging ([#8](https://github.com/RbBtSn0w/adg/issues/8)) ([bc392d1](https://github.com/RbBtSn0w/adg/commit/bc392d14f16993bc4ee8b4e3bf85ee2936063ddf))
* **plugins:** align `plugins update` with `skills update` (detect-then-update) ([#21](https://github.com/RbBtSn0w/adg/issues/21)) ([2b93c01](https://github.com/RbBtSn0w/adg/commit/2b93c01b03a65fab93a0befe3ea05b5d4639478f))
* refresh cached agents on plugin update ([#22](https://github.com/RbBtSn0w/adg/issues/22)) ([6566a74](https://github.com/RbBtSn0w/adg/commit/6566a7476d30495a94aa69a7e0de1bb60edae883))

### Fixed

* address cross-cutting correctness findings from PR review ([824db40](https://github.com/RbBtSn0w/adg/commit/824db4050860ec85c09325755bae2932b5384a26))
* address technical debt items TD-1, TD-2, TD-3 ([#13](https://github.com/RbBtSn0w/adg/issues/13)) ([955a69a](https://github.com/RbBtSn0w/adg/commit/955a69ad5cfa2f628ea3667548a8f542d29d54cf))
* project apps, add adapter parity test, harden prepack & audit gates ([#15](https://github.com/RbBtSn0w/adg/issues/15) [#17](https://github.com/RbBtSn0w/adg/issues/17) [#18](https://github.com/RbBtSn0w/adg/issues/18) [#19](https://github.com/RbBtSn0w/adg/issues/19)) ([#20](https://github.com/RbBtSn0w/adg/issues/20)) ([a63ad26](https://github.com/RbBtSn0w/adg/commit/a63ad264d3eec106e92e3d7bc4b805c09c3f74f8)), closes [#3](https://github.com/RbBtSn0w/adg/issues/3)
* **update-check:** notify on beta/rc updates via prerelease-aware compare ([#12](https://github.com/RbBtSn0w/adg/issues/12)) ([264163a](https://github.com/RbBtSn0w/adg/commit/264163aa47e60675c1a2a0e3817755328efae362))

### Changed

* **adapters:** fix naming, dedup strict logic (tech-debt [#9](https://github.com/RbBtSn0w/adg/issues/9)) ([#11](https://github.com/RbBtSn0w/adg/issues/11)) ([33d9727](https://github.com/RbBtSn0w/adg/commit/33d97274c6ba64bb709dee5c7478862edc87a10b))
* centralize CLI execution and availability logic into a reusable makeCli factory ([#16](https://github.com/RbBtSn0w/adg/issues/16)) ([00f1454](https://github.com/RbBtSn0w/adg/commit/00f1454dd6822dc005a11835bf052a5468975e64))
* **ci:** avoid literal skip-CI directive in prose ([dbfac2d](https://github.com/RbBtSn0w/adg/commit/dbfac2d7e87ffcec6153a4be07e9e43e6affb331)), closes [#6](https://github.com/RbBtSn0w/adg/issues/6)

## [0.3.0-beta.8](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.7...0.3.0-beta.8) (2026-06-22)

### Fixed

* address cross-cutting correctness findings from PR review ([824db40](https://github.com/RbBtSn0w/adg/commit/824db4050860ec85c09325755bae2932b5384a26))

## [0.3.0-beta.7](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.6...0.3.0-beta.7) (2026-06-22)

### Added

* refresh cached agents on plugin update ([#22](https://github.com/RbBtSn0w/adg/issues/22)) ([6566a74](https://github.com/RbBtSn0w/adg/commit/6566a7476d30495a94aa69a7e0de1bb60edae883))

## [0.3.0-beta.6](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.5...0.3.0-beta.6) (2026-06-22)

### Added

* **plugins:** align `plugins update` with `skills update` (detect-then-update) ([#21](https://github.com/RbBtSn0w/adg/issues/21)) ([2b93c01](https://github.com/RbBtSn0w/adg/commit/2b93c01b03a65fab93a0befe3ea05b5d4639478f))

## [0.3.0-beta.5](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.4...0.3.0-beta.5) (2026-06-22)

### Fixed

* project apps, add adapter parity test, harden prepack & audit gates ([#15](https://github.com/RbBtSn0w/adg/issues/15) [#17](https://github.com/RbBtSn0w/adg/issues/17) [#18](https://github.com/RbBtSn0w/adg/issues/18) [#19](https://github.com/RbBtSn0w/adg/issues/19)) ([#20](https://github.com/RbBtSn0w/adg/issues/20)) ([a63ad26](https://github.com/RbBtSn0w/adg/commit/a63ad264d3eec106e92e3d7bc4b805c09c3f74f8)), closes [#3](https://github.com/RbBtSn0w/adg/issues/3)

### Changed

* centralize CLI execution and availability logic into a reusable makeCli factory ([#16](https://github.com/RbBtSn0w/adg/issues/16)) ([00f1454](https://github.com/RbBtSn0w/adg/commit/00f1454dd6822dc005a11835bf052a5468975e64))

## [0.3.0-beta.4](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.3...0.3.0-beta.4) (2026-06-20)

### Fixed

* address technical debt items TD-1, TD-2, TD-3 ([#13](https://github.com/RbBtSn0w/adg/issues/13)) ([955a69a](https://github.com/RbBtSn0w/adg/commit/955a69ad5cfa2f628ea3667548a8f542d29d54cf))

## [0.3.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.2...0.3.0-beta.3) (2026-06-20)

### Fixed

* **update-check:** notify on beta/rc updates via prerelease-aware compare ([#12](https://github.com/RbBtSn0w/adg/issues/12)) ([264163a](https://github.com/RbBtSn0w/adg/commit/264163aa47e60675c1a2a0e3817755328efae362))

### Changed

* **adapters:** fix naming, dedup strict logic (tech-debt [#9](https://github.com/RbBtSn0w/adg/issues/9)) ([#11](https://github.com/RbBtSn0w/adg/issues/11)) ([33d9727](https://github.com/RbBtSn0w/adg/commit/33d97274c6ba64bb709dee5c7478862edc87a10b))

## [0.3.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.3.0-beta.1...0.3.0-beta.2) (2026-06-20)

### Added

* add support for Antigravity adapter and enhance agent detection ([#10](https://github.com/RbBtSn0w/adg/issues/10)) ([91d0a63](https://github.com/RbBtSn0w/adg/commit/91d0a6374f5dc25281667e306062bebf0fb08903))

## [0.3.0-beta.1](https://github.com/RbBtSn0w/adg/compare/0.2.1...0.3.0-beta.1) (2026-06-19)

### Added

* enhance plugin agent listing and error messaging ([#8](https://github.com/RbBtSn0w/adg/issues/8)) ([bc392d1](https://github.com/RbBtSn0w/adg/commit/bc392d14f16993bc4ee8b4e3bf85ee2936063ddf))

### Changed

* **ci:** avoid literal skip-CI directive in prose ([dbfac2d](https://github.com/RbBtSn0w/adg/commit/dbfac2d7e87ffcec6153a4be07e9e43e6affb331)), closes [#6](https://github.com/RbBtSn0w/adg/issues/6)

## [0.2.1](https://github.com/RbBtSn0w/adg/compare/0.2.0...0.2.1) (2026-06-19)


### Bug Fixes

* **brew:** Add Homebrew tap publishing for stable releases ([#5](https://github.com/RbBtSn0w/adg/issues/5)) ([0546dc9](https://github.com/RbBtSn0w/adg/commit/0546dc9172b8d93f1d7c34587df28383c21b52da))

# [0.2.0](https://github.com/RbBtSn0w/adg/compare/0.1.1...0.2.0) (2026-06-19)


### Features

* **version:** Add root version flag and cached update notice to the ADG CLI ([#4](https://github.com/RbBtSn0w/adg/issues/4)) ([bbce576](https://github.com/RbBtSn0w/adg/commit/bbce576b21de9822adff07c67d90b853b0cf4265))

## [0.1.1](https://github.com/RbBtSn0w/adg/compare/0.1.0...0.1.1) (2026-06-18)


### Bug Fixes

* **adapters:** codex projection passes skills root through in strict mode ([#3](https://github.com/RbBtSn0w/adg/issues/3)) ([f8de95d](https://github.com/RbBtSn0w/adg/commit/f8de95dff26d3e7032538b64919d7031ce6e8cef))

# [0.1.0-beta.3](https://github.com/RbBtSn0w/adg/compare/0.1.0-beta.2...0.1.0-beta.3) (2026-06-18)


### Bug Fixes

* address PR [#2](https://github.com/RbBtSn0w/adg/issues/2) review feedback ([f614817](https://github.com/RbBtSn0w/adg/commit/f6148173e32a331f6c7dd859b50dd85cd453253d))

# [0.1.0-beta.2](https://github.com/RbBtSn0w/adg/compare/0.1.0-beta.1...0.1.0-beta.2) (2026-06-18)


### Bug Fixes

* cut 0.1.0-beta.2 ([7ed703a](https://github.com/RbBtSn0w/adg/commit/7ed703a88b6d52c14605d62b4e7952c00839e6b2))

# Changelog

All notable changes to the `adg` toolkit are recorded here.

## Unreleased

## 0.1.0 — 2026-06-17

### Added — `adg plugins init --type plugin|marketplace|all`
The authoring scenario is now the `.agents/` artifact *kind*, not a runtime.
`--type plugin` (default) scaffolds `.agents/.plugin.json`; `marketplace`
scaffolds a `.agents/.marketplace.json` catalog; `all` scaffolds a catalog root
plus one starter member plugin in a subdirectory. (This is a different axis from
`adapt --target claude|codex|all`, which selects a runtime to project for.)

### Changed — vendor projections are no longer an authoring artifact
`.claude-plugin/` and `.codex-plugin/` are runtime projections produced at
**install** time (by `adg plugins add`, into the consumer tree) — authors commit
only `.agents/`. You run `adg plugins adapt` and commit projections solely to
publish to a runtime's native registry. Docs (`authoring.md`, `agents-spec.md`)
updated accordingly; `validate` projection-sync only applies when projections are
present.

### Removed — the `adapters` manifest field
Output paths for the runtime projections (`.claude-plugin/`, `.codex-plugin/`)
are ADG-internal conventions mandated by each runtime, not producer-configurable.
The `adapters` field is removed from the DSL (schema, types, `init`/`reverse`/
`import` scaffolding) and from `adapt` (always the default path). A stray
`adapters` from an old manifest is tolerated (ignored), so existing plugins keep
installing.

### Changed — consumer manifest-resolution priority
When a directory exposes more than one manifest, resolution order is now
`.agents/.plugin.json` (then legacy `.adg-plugin`) → Claude (`.claude-plugin`) →
Codex (`.codex-plugin`). Previously Codex was checked before Claude.

### Changed — simpler authored `marketplace.json` DSL
A `plugins[].source` may now be a plain string (local path shorthand, e.g.
`"./asc"`) in addition to the object form, and gains remote tagged-union forms
(`github` / `git`) in the schema. Catalogs gain top-level `description` / `owner`
(replacing `interface.displayName`); `policy` is documented as export-only. The
generated runtime export is unchanged (Codex still gets the object + policy
shape).

### Changed — plugin source manifest moves to `.agents/.plugin.json`
The canonical source manifest is now `.agents/.plugin.json` (was
`.adg-plugin/plugin.json`) — a neutral, vendor-agnostic home that mirrors the
`.claude-plugin/` shape. The repo source catalog convention is
`.agents/.marketplace.json`. Runtime projections (`.claude-plugin/`,
`.codex-plugin/`) and the Codex/Claude-facing `marketplace.json` export are
unchanged. The legacy `.adg-plugin/plugin.json` is still read (deprecated) so
existing plugins keep resolving. See [docs/agents-spec.md](docs/agents-spec.md).

### Changed — packaging is now a manifest-driven allowlist
Installing/cloning a plugin ships only its declared payload (component
directories named in the manifest + `README`/`LICENSE`/`CHANGELOG`/`NOTICE` +
generated projections) instead of copying everything minus
`.git`/`node_modules`. Dev cruft like `src/`, `test/`, `docs/` no longer leaks
into installs. The same allowlist drives both the copy and the content hash, so
in-place and copied installs hash identically (`src/package.ts`).

### Fixed — `adg skills` against private repos (and, in fact, all updates)
A private skill source (`adg skills update`) reported `✗ Failed to fetch tree`
then falsely claimed "up to date". Investigating uncovered three stacked bugs in
the vendored skills fork, all now patched (see `vendor/skills/PROVENANCE.md`):

1. **Private repos never authenticated.** `fetchRepoTree` only retried with a
   token after a rate-limit 403; a private repo returns 404 to anonymous callers,
   so the token was never used. Now retries authenticated on 401/403/404.
2. **Updates could never run.** The updater re-invoked a built `bin/cli.mjs` that
   a source-only vendoring doesn't ship ("CLI entrypoint not found"). Now invokes
   the TS source entry via Node type-stripping.
3. **Every clone failed.** simple-git ≥3.36 blocks `filter.*.smudge/clean`
   configs unless opted in. Added `unsafe: { allowUnsafeFilter: true }` (the
   filters are set empty — disabling LFS — so this is safe).

Also: failed update sources are now surfaced (with a `GITHUB_TOKEN` / `gh auth
login` hint) instead of being hidden behind a false "all up to date", and the
`gh`-token warning text no longer hardcodes "rate limit reached".

### Fixed — collection repos no longer "fully update" every run
A repo containing many skills re-flagged **all** of them as needing an update on
every `adg skills update`, regardless of what changed. Root cause: install and
update used two different hash schemes. A github source records the git **tree
SHA** when the Trees API succeeds, but the git-clone fallback recorded a sha256
**content hash** — and update-check always compares against the tree SHA, so any
clone-fallback install (e.g. a private repo before the auth fix above) mismatched
forever. Now the clone fallback derives the git tree SHA too (one scheme), and a
self-heal normalizes pre-existing legacy hashes on the next update — no lock wipe.

## 0.1.0-alpha.1 — 2026-06-12

First alpha. The architecture and scope are frozen in [docs/agents-spec.md](docs/agents-spec.md).

### Added
- **Two-domain CLI**: `adg plugins <verb>` and `adg skills <verb>` under one
  umbrella binary, each mapped to one subtree of the universal `.agents/` home.
- **Plugins domain** (zero runtime deps): `init`, `adapt`, `validate`, `add`,
  `import`, `import-skills`, `link`, `update`, `list`. One canonical
  `.adg-plugin/plugin.json` source projects to `.codex-plugin` / `.claude-plugin`
  via an adapter registry; provenance + `sha256` integrity live in
  `.plugin-lock.json`, with `marketplace.json` as a thin runtime export.
- **Skills domain**: vendored fork of `vercel-labs/skills` delegated to via the
  `adg skills` namespace (see `vendor/skills/PROVENANCE.md`).
- **Architecture spec** at `docs/agents-spec.md` (goals, directory layout, artifact
  ownership, core data structures, multi-agent anti-scatter guarantees).
- Guard tests pinning the `.agents/` core invariant against future re-vendoring.

### Changed
- Maintain a single `.agents/` home across both domains. Patched the vendored
  skills fork so the **global skill lock** and the **universal global skills
  dir** resolve under `$XDG_STATE_HOME/.agents` (or `~/.agents`) instead of
  upstream's split `$XDG_CONFIG_HOME/agents/...` and `$XDG_STATE_HOME/skills/...`
  paths. Both patches are recorded in `vendor/skills/PROVENANCE.md`.
