# Branching and release

`main` is the only integration trunk. Create short-lived feature/fix branches from
current `origin/main`; submit reviewed squash PRs to `main`. Keep Conventional
Commit titles and breaking-change footers. PR metadata and the actual engine-selected
release range use the same conventionalcommits parser, with refactor yielding patch.
No commit SHA exemptions are permitted.

## Publication

`.github/workflows/release.yml` runs Friday at 07:00 UTC (15:00 Asia/Singapore)
and by manual dispatch on main. Both jobs require `RELEASE_ENABLED == 'true'`;
unset disables publication. CI and PRs never publish. develop beta, PR previews,
promotion PRs, sync-back and Dependabot retarget writers have been removed.

The read-only job installs locked dependencies, verifies the candidate, builds once,
packs once with scripts disabled, runs publint and exercises the installed packed
CLI. An immutable same-run artifact ID carries the candidate SHA and SHA256 checksum.
The publisher restores those exact bytes and checks live main immediately before
semantic-release. Any read error, empty result or drift fails closed.

semantic-release alone selects the version and creates the tag/notes. Its stateless
payload hook updates only the restored package manifest version and archives the
same files without build, pack or lifecycle scripts. npmjs and GitHub Packages
receive the identical final archive. Existing versions require matching SHA512
integrity; registry/auth failures are errors. Each successful target writes a receipt.
The GitHub Release attaches the archive, identity and registry receipts. Homebrew
continues through the existing release App and tap updater after a real release.
The release job never writes version/changelog commits to main.

## Activation and recovery

This migration is default-off, not evidence of operational publication. Before enablement,
verify npm trusted-publisher binding to this repository and exact workflow filename
`release.yml`, supported Node/npm OIDC, package/tag permissions, release App access to
the Homebrew tap, and real release baseline/history. Configure PR squash title/body
and required checks separately. Do not change credentials as a fallback on failure.

Publication across registries, GitHub and Homebrew is not transactional. Download this
run's final archive/identity and target receipts after partial failure; verify candidate,
version and archive digest, then explicitly recover only the missing side effect.
A later semantic-release no-op does not repair a missing mirror/Release/tap entry.
Never republish different bytes at an existing version or rewrite tags. External old
controllers/timers must be disabled at the separately authorized cutover. Remote develop
is retained inactive; branch deletion is a separate owner action.

## Local checks

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test
pack_dir=$(mktemp -d)
NPM_CONFIG_IGNORE_SCRIPTS=true npm pack --ignore-scripts --pack-destination "$pack_dir"
npm run test:package -- "$pack_dir"/*.tgz
node --test test/release-payload.test.mjs
```
