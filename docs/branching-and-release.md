# Branching and release

`main` is the only integration trunk. Use reviewed, short-lived squash PRs to
`main`, with strict Conventional Commit title/body checks and breaking declarations.
The release history guard shares the canonical parser but checks semantics rather
than PR style. Real merge metadata and the first initialization snapshot are handled
from commit ancestry; malformed ordinary commits and fake merges still fail. No
commit SHA exemptions are permitted.

## Automated Friday/manual publication

The existing `.github/workflows/release.yml` runs Friday 07:00 UTC (15:00 UTC+8),
or manually on `main` with `operation=release` (the default). No release PR or
recurring approval is required. CI and PRs never publish. Read-only analysis and
verification run independently of `RELEASE_ENABLED`; every publication path still
requires that variable to equal `true`. This implementation does not enable it.

Locked tooling installs without lifecycle scripts. `release-analysis.mjs` runs the
real semantic-release engine in a credential-scrubbed local mirror, with only
semantic/history and notes plugins. No npm/GitHub service plugin runs there.
A no-release result skips product builds and packaging. A release candidate runs
product checks, builds once, packs once without lifecycle scripts, and validates
the installed archive with publint and the package smoke test. Artifacts carry
the exact candidate SHA and checksum by immutable same-run artifact ID.

Publication restores those bytes, checks live main immediately before the engine,
and checks it again in the last prepare hook before tag creation. An unreadable,
empty or changed ref fails closed. The payload hook may change only the package
manifest version, then archives existing files directly. Before any package mutation,
the hook must read the verified analysis once and match its exact candidate SHA,
version, tag and complete notes to the current engine decision. Missing analysis
or changed notes, including a UTC-date rollover, requires fresh analysis and
verification before publication. npmjs and GitHub Packages receive identical
final bytes, with SHA512 integrity reconciliation and per-target receipts. GitHub
attaches the archive and metadata. No version/changelog commit is written to main.

Before normal publication of a missing version, each registry receives a read-only
channel check. An already newer `latest` stops that write; read errors and malformed
channel data fail closed. Older, equal or missing `latest` retains the ordinary
automatic publication path. Matching existing versions receive read-only checks.
The original engine version and sealed bytes remain fixed.

This guarantee assumes one authorized normal writer per package. All authorized
new issuance uses the scheduled/manual `Release` workflow and its `release-main`
concurrency group. External owner writes are outside that lock and can occur between
the channel check and publication. The check is not a compare-and-swap and does
not provide global atomicity against arbitrary external publishers. Friday normal
publication remains automatic; no coordinator or recurring approval is introduced.

ADG also updates the Homebrew tap with its existing release App and formula updater.
The updater compares the npm archive digest to the original final archive, rejects
a newer tap version and rejects conflicting bytes at the same version.

## Recovery of partial publication

Dispatch the same workflow on current `main` with `operation=recover`, the original
`source_run_id`, and original sealed `release-receipts-*` artifact's `artifact_id`.
Both IDs are required in recovery mode. This uses current trusted recovery code;
it does not run semantic-release, rebuild, retag, overwrite assets, or select a new
version. Main may have advanced. Always reference the original release artifact,
even when retrying recovery; a recovery artifact is not a new publication source.

Recovery validates GitHub repository/workflow/run/event/main association, immutable
artifact ID/run/candidate, expiry and ZIP digest, sealed repository/run/candidate,
package version/name, tag, SHA256 and registry integrity. It peels the existing tag
and requires the original candidate. Missing or unverifiable evidence fails closed.
Existing registry versions and GitHub assets must match original bytes. Only missing
targets are written; existing matching targets are observed. Authentication/network
errors remain failures, never assumed absence or success. Recovery may publish missing original bytes under its exclusive recovery tag,
then reads the stable `latest` channel. It never calls `npm dist-tag add` or
`npm dist-tag rm`. Only a verified same/newer `latest` can complete the registry
target; older, missing or unverifiable channels remain unconfirmed. Any owned
recovery tag is retained intentionally, with no recurring cleanup requirement.
Restored bytes are preserved even when channel delivery cannot be confirmed.
Participating jobs share `release-main`; external manual writers are
outside that lock. GitHub draft lookup uses paginated release listings, validates
the original notes/assets and preserves the latest release designation. Expired artifacts and
conflicting remote bytes require owner investigation; never reconstruct the payload.

`release-result.json` and the Actions summary separate verification from publication
and list each target, artifacts, failure stage and recovery source. Disabled runs
still report verification. A successful analysis with no version reports no-release;
partial publication remains partial until all required targets have receipts.

## Daily SOP

1. Develop on a short-lived branch; retain the breaking footer in the squash body.
2. Check normal CI/PR evidence and merge through the normal reviewed PR process.
3. Friday publication is automatic after one-time activation; use manual
   `operation=release` for an intentional off-cycle run on main.
4. Inspect the Actions summary and `release-result.json`. No-release is normal.
5. For partial failure, retain the original run/artifact IDs and dispatch recovery.
   Investigate unknown authorization or digest failures without changing identity.

## One-time external setup and remaining unknowns

Source checks do not prove runtime activation. Before enabling publication once,
verify the npm trusted publisher binds this repository and exactly `release.yml`,
the supported Node/npm OIDC setup, GitHub package/tag/release permissions, current
release baseline/history, PR squash metadata preservation and required checks.
The selected safe recovery policy performs no `npm dist-tag add` or `npm dist-tag rm`,
so **Allow npm dist-tag** is not an activation prerequisite for this workflow.
That optional permission is independent of direct publishing and disabled by
default; existing package settings are not changed. See
[npm trusted-publishing dist-tag permissions](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).
Normal scheduled publication still publishes a verified new version through the
existing trusted-publishing identity. Recovery only observes channel delivery and
cannot promise to repair an older or missing `latest`.
Verify the existing release App's private key, installation and write access to
`RbBtSn0w/homebrew-tap`; no fallback credential is introduced.
Disable old controllers/timers at the authorized cutover; remote develop remains
inactive and is not deleted here. GitHub Free is supported with ordinary jobs,
concurrency and the existing token/OIDC identities; no protected environment or
paid deployment feature is required. These are one-time configuration checks,
not a weekly approval process.

## Local verification

```bash
npm ci --no-audit --no-fund --ignore-scripts
node --test test/release-*.test.mjs
node .github/release-train/cli.mjs analyze --profile npm
# Run the repository's product verification suite and archive smoke check.
actionlint .github/workflows/release.yml
```

## Historical local readiness evidence (2026-11-07)

The local real-engine analysis selected `0.11.2` from baseline `0.11.1` at
candidate `27948a62f969be1d893292c72146df499a72b5da`. Typecheck/build, all 677
product tests, 15 release behavior/contract tests, doc/test-isolation/vendor checks,
archive publint and installed-package smoke checks passed. Production audit found
zero vulnerabilities. This is local evidence, not publication activation.

Workflow validation (`actionlint`) and whitespace checks passed. Product/release
tests used installed Node.js 25.8.2; installed-package smoke and available production
audits used Node.js 22.22.2. The workflow keeps Node.js 24 for release tooling.
No remote publication, tag creation, workflow dispatch or configuration activation
was performed. npm/package configuration and lockfiles are unchanged.

## Historical squash compatibility (2026-11-07)

Historical standard GitHub PR squash envelopes are ordinary commits: their full
Conventional Commit body must validate. Thin `release-commit-analyzer.mjs` and
`release-notes-generator.mjs` adapters use the same message projection and forward
all existing options to the official plugins. True multi-parent merges retain
original messages and complete breaking notes. Empty/malformed/nested bodies and
invalid skip-marker messages still fail. No SHA exemption, baseline fabrication
or Git history rewrite is used.

## Current Actions operation and runtime ownership (2026-11-08)

The workflow is named **Release**. Run titles distinguish scheduled/manual releases
from recovery of an original run. Read **Release outcome**, the only final Summary,
for independent analysis, verification, publication enablement and channel evidence.
An omitted, stale or incomplete receipt means **Not confirmed**. A concluded
synchronous run never becomes a pending success. The configured intended targets
must all have candidate/version/digest, timestamp and remote identity evidence.
Job success and receipt-file existence cannot confirm publication.

For a failed publication, copy the populated recovery command from the original
outcome only when recovery is available. It includes the original sealed artifact
ID, run and producer attempt, digest and expiry. Missing/expired artifacts or an
unverified original tag block this command. A later recovery retains the original
lineage, even after main advances. **Re-run failed jobs** reuses immutable successful
producer IDs; it does not switch to current main. **New release run** analyzes a
fresh main candidate. Recovery reconciles original bytes/notes without rebuilding,
retagging or moving a newer registry `latest` backward.

`.github/release-train.json` owns the npm profile and complete channel list.
`.github/release-train/` is generated shared runtime, not consumer-owned source.
The manifest records its selected source revision and SHA-256 hashes. Local
adapters in `scripts/` own package preparation, registry/GitHub readback and final
observation merging; obsolete common implementation entrypoints have been removed.
Semantic-release remains the version/notes authority. Keep the same `release.yml`
OIDC identity and the existing permissions, selected App and default-off switch.

Check generated integrity locally without an upstream checkout:

```bash
node .github/release-train/sync.mjs check --consumer .
node --test test/release-*.test.mjs
actionlint .github/workflows/release.yml
```

To upgrade, select an authorized upstream source checkout/revision and run its
`engineering-workflows/skills/repo-release-train/scripts/release-train/sync.mjs`
with `sync --consumer "$CONSUMER" --revision "$SOURCE_REVISION"`. Review the
manifest and consumer adapter compatibility, then run integrity, release regression,
product verification and workflow checks. Generated edits/unknown files stop sync;
resolve ownership rather than overwriting drift. Do not copy private upstream
fixtures or expand component visibility. Earlier dated readiness/audit sections are
historical evidence, not current activation or production acceptance.

An all-job rerun conservatively stops at analysis: a prior partial publication may
already have created its baseline tag. Follow the original attempt's outcome and
recovery command, or create a new manual release run to validate fresh main.
Failed-only retries that reuse a successful analyzer/verified producer retain its
artifact IDs; this guard does not re-run or replace that producer.

## Current local verification (2026-11-08)

Using Node.js 22.22.2, the controlled generated-runtime integrity check, all
28 release regressions and all 677 product tests passed. The new receipt
regressions were observed RED before implementation (file-existence false success,
concluded synchronous pending state and broad artifact selection), then GREEN.
First-failure recovery, original lineage, conflicting digests, required targets and
conservative all-job retry handling also pass. Repository type/build checks and applicable lint checks, installed
archive smoke, workflow actionlint and whitespace checks passed. Production audit
reported zero vulnerabilities.

These are local synthetic/installed-package checks, not an observed Actions screen
or a registry publication rehearsal. Full local-server product tests required
normal loopback access. No release dispatch, activation, tag, publication, new
credential, commit or push was performed by this implementation step. Publication
remains default-off and existing compatibility/dependency boundaries are retained.

The final observer writes JSON and Summary before returning a failing process status
for failed validation, synchronous partial publication or reporting infrastructure
failure. Producer downloads and the final outcome/upload use `always()` so failed
readback cannot hide the retained evidence. Legacy schema1 completion claims remain
unconfirmed. Recovery availability uses the shared original-run/workflow/event,
artifact-role/digest/expiry and tag validation; the still-running original report
is explicitly allowed without accepting another active run.

## Recovery preflight review follow-up (2026-11-08)

Recovery instructions require a current read-only GitHub observation of the
original tag, notes, stable channel and every existing original asset. The sealed
producer observation retains the original notes and both expected asset SHA-256
identities. Missing Release/assets and a matching draft remain repairable;
conflicting notes/bytes/duplicate assets are conflicts, while read errors remain
unknown. Neither conflict nor unknown provides a recovery command.

Actual recovery performs the same preflight before either registry can be written,
then checks GitHub again before reconciling its assets. A later remote change can
still interrupt a distributed release; the implementation preserves the resulting
partial evidence rather than promising atomic cross-service publication.
`recovery.publication_state` records the readback classification independently
from artifact availability. The focused release suite passed 33/33, including
RED/GREEN regressions for conflict instructions and pre-registry side effects.

## Late review: durable outcomes and channel evidence (2026-11-08)

Registry completion requires the original sealed checksum plus a legal
`latest_version` at least as new as the sealed version and an actual
`channel_observed_at` readback timestamp. Byte confirmation and channel delivery
remain separate: failed channel readback retains an unknown receipt with confirmed
byte evidence, without inventing a channel timestamp. The final observer does not
offer a command that claims recovery can change `latest`.

An early recovery failure retains the original dispatch IDs as unverified
inputs. The final observer reads and verifies the original run, artifact role,
archive digest, payload and remote effects before offering a retry command.
Malformed producer JSON becomes a `report-inputs` failure while other valid
observations, the final JSON and Summary survive. During GitHub asset reconciliation,
the final readback rechecks the same release ID, original notes and stable visibility.


### Recovery request evidence and one-shot intents

Use the original publication artifact containing the sealed bytes and request
receipts. A structured E404 does not prove that no request was sent: accepted or
uncertain requests are observed without uploading again. Missing original request
evidence cannot authorize a recovery upload.

The recovery workflow first inspects and restores the trusted original once.
Each registry then has a read-only preflight, a conditional immutable intent named
`release-recovery-intent-<source-run-id>-<target>`, and its own publication and
observation phase. Visible bytes, uncertain original requests and prior trusted
intents need no new marker or upload. A failed preflight creates no marker; an
unverified registry failure stops before the next target's marker. Only a channel
failure after byte verification can continue to the next target and GitHub.
All phases share one 15-minute registry observation deadline. Finalization emits
success only when both registries and GitHub are confirmed.

A marker consumes only that registry's original `not-run` authorization, even
when a later request or observation fails. Later recoveries observe without
retransmitting it; an untouched registry retains its independent authorization.
Legacy global markers conservatively block uploads to both registries. The
legacy `all` test entry also requires durable intent before any upload.

If visibility never arrives and the request cannot be proven unsent, keep the
target unconfirmed. Do not delete intent artifacts, force publication, change
latest or overwrite a version to bypass this condition. Diagnose the original
run and retain its evidence; use a genuine forward fix through the normal verified
main/semantic-release path when the old delivery cannot be safely completed.
Normal scheduled publication retains its automated path; this restriction applies
to uncertain recovery, not a recurring approval.


Recovery preflight retains matching original bytes as observe-only evidence.
If the next registry lookup temporarily returns E404, recovery waits within the
shared budget without creating another request intent or publishing again.
Finalization checks complete payload, remote identity and channel observations;
it cannot declare delivery from the receipt status alone.

## Node support and CI package manager

The supported runtime range is `^22.22.2 || ^24.15.0 || >=26`, aligned with the
selected npm 12.2.2 toolchain. Node 22.18, Node 23 and Node 25 are no longer
supported. This compatibility change is recorded as breaking release metadata;
semantic-release remains responsible for the next version. Existing releases
retain their original runtime declarations.

All CI matrix entries, PR commit validation and release jobs select npm 12.2.2
from a runner-temporary installation. The matrix covers exact Node 22.22.2 and
24.15.0 minimums plus Node 26, with current Node 24/26 on macOS and Windows.
No old-runtime package-manager exception remains.
