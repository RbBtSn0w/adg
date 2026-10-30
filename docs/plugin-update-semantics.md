# Plugin Update Semantics and Delivery Tracking

**Status:** Local implementation verified; native runtime validation tracked separately  
**Decision date:** 2026-10-30  
**Delivery owner:** ADG lead; project-management tracking in this document  
**Tracking issue:** [ADG #161](https://github.com/RbBtSn0w/adg/issues/161)

## Problem and approved direction

A repository can publish multiple plugins under one synchronized version or
version each plugin independently. Both are valid publisher policies. ADG must
explain whether a release changed plugin content, only its version, or the
effective installation, without requiring publishers to change their release
automation.

Previously, one `changed` flag combined source, version, lock-record, and runtime
refresh concerns. A synchronized version bump therefore appeared indistinguishable
from a skill update. An unchanged plugin could also retain an older checked
revision, preventing subsequent checks from taking the repository fast path.

The approved solution belongs in ADG. The apple-skills selective-version proposal
in [PR #90](https://github.com/RbBtSn0w/apple-skills/pull/90) is superseded as the
general fix. The lead's live check found that PR already merged at
2026-10-30 10:17:31 UTC (commit `580ee607`) and release `v1.32.1` followed at
10:18:21 UTC. It cannot now be closed as an open proposal. Reverting published
producer behavior is a separate decision; this ADG delivery supports both
publisher policies without depending on such a revert.

## Required boundaries

| Boundary | Contract |
| --- | --- |
| Publisher version | Preserve the publisher's version. Accept synchronized and independent version policies without new author configuration. |
| Source integrity | Preserve exact source and installed digests; a comparison that excludes only the version field must not replace integrity validation. |
| Change classification | Distinguish version-only changes from other packaged files or normalized manifest changes. Unknown or unavailable comparison input is handled conservatively. |
| Repository checkpoint | Advance a checked revision only after the relevant source has been successfully examined. A checkpoint-only update must not imply a content update or native refresh. |
| Effective selection | Keep unselected payload separate from the selected installation. Changes to dependency closure and selected configuration remain significant. |
| Runtime synchronization | Plan native work separately from human-readable change reasons. A version-only release may still need native refresh to preserve native manifest/cache correctness. |
| Runtime outcome | A successful source update does not prove native registration, cache replacement, or loading in an existing session. Report unavailable, failed, and unverified outcomes accurately. |
| Desired state | Preserve disabled plugins and stored selections throughout update and recovery. |

Classification must cover canonical manifests, imported native manifests, and
Default DSL sources. Removing an entire manifest from comparison would hide
dependency, hook, MCP, component-pointer, and other configuration changes and is
not an acceptable version-only optimization.

## Scope and ownership

| Workstream | Owner | Deliverable | Completion evidence |
| --- | --- | --- | --- |
| Core comparison | Core implementation worker | Classification and exact-source comparison with backward-compatible install outcomes | Focused regression tests and implementation diff |
| Checkpoint and reporting | Update/reporting worker | Repeat-check behavior, classified output, and runtime work selection | Isolated update tests, renderer tests, and clone-count assertions |
| Runtime boundary | Core/update workers; lead integrates | Conservative native refresh and explicit failure/unavailable results | Lifecycle test doubles; native evidence recorded separately |
| Project tracking | Project-management worker | Scope, acceptance matrix, risks, and remaining validation | This document and linked ADG issue |
| Integration | Lead | Combined checks, review, and final acceptance | Commands/results from the integrated working tree |

The first delivery retains conservative native behavior where the runtime's
capabilities have not been demonstrated. Skipping native refresh for version-only
changes is not a requirement. Content-addressed native caches, synthetic semantic
versions, a new producer release protocol, and a universal plugin versioning
strategy are outside this delivery.

## Acceptance matrix

Every implementation row requires an automated regression or an explicit existing
test reference. Native validation rows require their own runtime evidence and must
not be marked complete using test doubles alone.

| ID | Scenario | Expected outcome | Evidence status |
| --- | --- | --- | --- |
| A1 | Synchronized repository release changes one skill and all plugin versions | Changed plugin is a content update; peers are version-only updates; all versions remain truthful | Passed: `plugins-update.test.ts` — `updatePlugins distinguishes lockstep release versions from component changes` |
| A2 | Independently versioned release changes one plugin | Only the affected plugin is reported as changed; peers remain untouched | Passed: `plugins-update.test.ts` — `updatePlugins reports updated when upstream content changed` and activation filtering test |
| A3 | Payload changes without a version bump | Detect content change and perform required synchronization | Passed: `plugins-update.test.ts` — `updatePlugins refreshes remaining skills after a skill is deleted upstream` |
| A4 | Manifest metadata, dependencies, component pointers, or selection dependencies change | Classify as more than version-only; preserve existing dependency and authorization checks | Passed: `plugin-changes.test.ts` — `same-version manifest configuration changes remain content updates` and `dependency metadata remains a content change and is persisted`. Existing dependency-closure coverage: `install.test.ts` — `component selection materializes its declared skill dependencies`; complete suite passed (661/661) |
| A5 | Source changes only outside the current selection | Source update and effective-selection change are not conflated; skip native work only if the effective input is proven unchanged | Passed: `plugins-update.test.ts` — `updatePlugins retains unselected source changes without unnecessary runtime refresh` |
| A6 | Disabled plugin receives content or version update | Refresh stored source while keeping it disabled; no activation | Passed: `plugins-update.test.ts` — disabled remote payload and disabled local source regression tests |
| A7 | Repository advances but one plugin's exact bytes remain equal | Record the verified revision without a content update or timestamp/native-refresh churn | Passed: monorepo checkpoint regression and `plugin-changes.test.ts` — `verified identical bytes advance source revision without installation timestamp churn` |
| A8 | Repeat update against the same verified repository revision | Avoid another clone caused by an unchanged peer's stale checkpoint | Passed: `plugins-update.test.ts` — `updatePlugins checkpoints unchanged monorepo members to avoid a second clone` |
| A9 | Source or classification fails partway through checking | Do not record an unchecked revision as a successful checkpoint or report a failed source as synchronized | Fetch-failure path passed: `plugins-update.test.ts` — `updatePlugins surfaces a source that cannot be fetched`; checkpoint persistence is confined to each successfully verified plugin; a failed peer cannot receive an unchecked checkpoint (integration code review) |
| A10 | Native synchronization fails or the runtime is unavailable | Preserve source facts, expose failure/skipped state, and avoid claiming the runtime has loaded the new version | Passed: source-version/runtime-failure test plus three failure/unverified renderer regressions in `render.test.ts`. Real unavailable-runtime behavior remains N1–N3 validation scope |
| A11 | Previous cache/comparison data is missing or a retained lock format is read | Recover or conservatively refresh; no false unchanged result or publisher burden | Passed: `plugin-changes.test.ts` — `missing comparison cache conservatively avoids a version-only claim`. Existing legacy/native/Default DSL recovery in `source-cache.test.ts` and compatibility-read v3 persistence in `telemetry.test.ts` passed in the complete suite (661/661) |
| A12 | Canonical, native, and Default DSL manifests are used | Classify normalized metadata correctly without losing exact integrity checks | Passed: canonical lockstep and Default DSL identity regressions in `plugins-update.test.ts`, plus `plugin-changes.test.ts` — `native manifest releases use normalized metadata for version-only classification` |
| N1 | Native version-only refresh | Observe actual native manifest/version registration and retained enabled/disabled state for each supported runtime | Not run |
| N2 | Native same-version content refresh | Observe actual replacement/loading behavior; do not infer it from the ADG lock alone | Not run |
| N3 | Existing session versus a new session | Record whether a reload or new session is needed separately from registration success | Not run |

## Verification and rollout

The lead records focused regression results first, then type checking, build, and
the repository test suite appropriate to the integrated change. New telemetry
must use bounded change/outcome attributes and must not include paths, user data,
raw arguments, or secrets. Regression fixtures use temporary caches and explicit
revision resolvers to avoid touching user installations or making incidental
network calls.

Existing `updated`/`unchanged` consumers must retain a compatible interpretation;
new detail may refine their meaning but must not silently reverse it. Runtime
refresh failures continue to follow the command's established exit-code contract.

This work changes update decisions and provenance persistence. Before delivery,
review partial failure, explicit recovery, cache recovery, timestamps, and
disabled state together. This delivery adds no durable runtime retry queue and
no lock-schema migration.

### Explicit synchronization recovery

A verified source checkpoint remains valid when a subsequent native refresh
fails. Preserve that source outcome and report the native failure or unverified
result separately, using the established nonzero failure outcome where
applicable. The report must provide an actionable pending-sync message.

Ordinary `plugins update` may take the already-checked source fast path on the
next invocation; it is not an automatic retry mechanism for the failed native
operation. Retry through `adg plugins sync` with the same scope and the intended
runtime target, for example
`adg plugins sync --global --target codex <plugin-name>` for one plugin in the
global Codex store. This is an explicit recovery contract, not a persistent work
queue. Neither a source checkpoint nor successful command dispatch proves that
an existing session has loaded the new plugin.

## Delivery record

- Architecture decision: consumer-side separation approved by the user.
- Historical isolated investigation: unchanged peers can retain an older revision
  and cause repeated clone-path execution. This is a decision-path reproduction,
  not a network performance benchmark.
- Lead-reported focused result: 55/55 tests passed across
  `test/plugins-update.test.ts` and `test/render.test.ts`; type checking passed.
- Lead-reported core result: 12/12 focused regressions passed, including missing
  comparison cache, dependency metadata, imported native metadata, explicit
  selection policy across future additions, and auxiliary Antigravity MCP repair.
- Independent review found and verified fixes for selection-policy persistence,
  auxiliary projection integrity, and staging-path leakage in translated hooks.
  The hook regression verifies the final installed runner path and an unchanged
  update that does not request runtime refresh.
- Lead-reported type checking, build, documentation links, CLI test isolation,
  and diff checks passed.
- Complete repository suite: `npm test` passed 661/661, zero failures and skips.
  Type checking and build passed on the final implementation. The suite ran
  with permission for the OTLP test to open its localhost listener.
- Live native runtime validation: not run as part of project-document authoring.
- Tracking issue: [ADG #161](https://github.com/RbBtSn0w/adg/issues/161).
- apple-skills PR closure request: blocked by its already-merged and released
  state, confirmed by the lead. No producer revert is included in this delivery.
- ADG implementation stays local until a separate commit/push/PR instruction.

The tracking issue should remain open until its required implementation evidence
is recorded. Deferred native optimizations must be identified explicitly; a
conservative, tested refresh path can ship without claiming those optimizations.
