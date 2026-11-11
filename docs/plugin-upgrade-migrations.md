# Plugin update and recovery plan

## Product contract

`adg plugins update -g` updates the selected installation, preserves component
and runtime choices, and resumes unfinished work. Publishers distribute their
ordinary manifests, skills and marketplace. ADG records installation history
and prepares recovery inside its own store.

The unpublished `adg.migrations/v1` publisher protocol is withdrawn. Remove its
schema, reader, producer declaration, producer validator and public authoring
instructions. Consume existing marketplace `renames` entries for plugin
identity changes and explicit removals. Follow chains to a current entry or
`null`, rejecting cycles and conflicting ownership before publishing changes.

Compare verified installation history with the current catalog in the same
source and ref. Preserve current-owner matches. A unique same-name skill
identifies a relocation. Ambiguous matches require a decision. Preserve native
component authorization independently of relocation.

Record complete source inventories and effective user selections before an
installation changes. Recover a legacy partial update from the immutable
revision recorded by its installed predecessor. If that revision is absent,
verify the predecessor against its release tag before using that catalog.
Recover only previously installed identities. Missing historical choices on a
surviving newer installation require one restoration decision. A fresh current
installation receives no legacy prompt.

An absent entry without a verified replacement remains usable and is reported
as no longer available upstream. Explicit removal or an accepted replacement
retires it. Whole-source subscription and selected-plugin updates retain their
own intent. `update --all` includes current additions once, preserving component
selections and explicit exclusions.

## Follow-up: partial selections and uncertain history

Status: implemented on 2026-11-11. Type checking, build and all 830 ADG tests
pass. Final isolated native acceptance of this follow-up passed all three
scenarios below. The earlier baseline acceptance applies to its recorded
build only.

The unit of preservation is the user's selected skill set within its source,
ref and scope. A plugin split or merge changes ownership without expanding that
set. Preserve each runtime's enabled state and existing destination selections.
Record requested selections separately from effective mandatory dependencies;
dependency installation must not become evidence of a broader user choice.
Projection rebuilding, enabling and local refresh also retain that distinction;
internal replay does not record a new user choice. Recompute dependency closure
from the new manifest rather than moving obsolete dependencies as direct
skill requests.

### Evidence and defaults

| Available evidence | Permitted inference and default |
| --- | --- |
| Verified historical requested selection | Transfer only selected skills and required dependencies to verified current owners. |
| Verified historical installed payload | Preserve proven effective contents; do not infer direct user choices or a subscription to other skills. |
| Complete source cache, old release or marketplace inventory only | Identify available historical candidates; require an explicit choice before restoring any unproven selection. |
| Missing or conflicting evidence | Preserve current working contents and unresolved old owners, defer uncertain restoration, and report the limitation. |

An old release establishes what the publisher shipped. It does not establish
which skills this user selected. Verify cached source and installed payload as
different evidence types even when both originated from the same release.

For uncertain restoration, make "Keep current selection (Recommended)" the
default. Offer individual selection and explicit restoration of all candidates
as alternatives. Describe candidates as having unknown prior selection;
do not label them as confirmed previously installed skills. Individual
selection starts with no unproven candidates selected. Existing verified
contents remain selected independently of that candidate list.

Whole-source subscription controls plugin membership. Check per-plugin skill
selections and the provenance of historical policy before any automatic
restoration; `mode: all` must not override a recorded partial skill selection
or authorize an unknown historical selection. A one-time `update --all`
continues to preserve saved skill choices and executable permissions.
An explicitly recorded full-component choice remains valid within its declared
scope. Infer no full-component policy from missing legacy data.

### Deferred recovery and execution

Store deferred recovery separately from explicit exclusions in ADG's own
history. Deferral grants no installation or removal permission. Bind it to the
source, ref, scope and reviewed evidence, suppress repeated prompts while the
case is unchanged, and allow reconsideration through the existing management
flow. A relevant ownership or authorization change requires fresh review.
The existing `update --repair` path reopens deferred choices without requiring
a publisher declaration or a separate recovery command.

Non-interactive runs apply independently verifiable updates and defer uncertain
restoration without a prompt. An interactive default or cancellation must not
be converted into permission to restore, remove or activate anything. Preserve
completed work and retryable failures according to existing command semantics.

Reports distinguish deferred candidates, explicitly excluded skills, restored
skills and actual failures. Successful updates may report the installed
selection up to date with a separate deferred-recovery notice; they must not
claim that historical recovery is complete. JSON exposes the same distinction
without forcing automation to interpret display text.

Use the existing lock, history and transaction mechanisms, extending client
state only where required to preserve evidence and deferral semantics. Keep
requested and effective choices durable before native side effects. Emit only
aggregate evidence, selection and deferral counts through existing telemetry.
Publishers continue to use their ordinary manifests and rename metadata.

### Implementation order and additional acceptance

1. Add failing regressions for conservative defaults, evidence classification,
   partial selections under whole-source subscription, and deferral semantics.
2. Implement planning and durable client-state changes, then update review
   defaults and text/JSON reporting. Test the ordinary update API and CLI.
3. Repeat package checks and isolated native acceptance against the resulting
   build, retaining the existing authorization and interruption regressions.

| Scenario | Required outcome |
| --- | --- |
| Old plugin ships `a,b,c,d`; user selected `a,c`; current owners ship `a,b,e` and `c,d,f` | Update exposes only `a,c` plus required dependencies. No `b,d,e,f` are activated. All three hosts agree; repetition is unchanged. |
| Partial selection under `mode: all`, ordinary update and one-time `--all` | Recorded skill choices survive each route; new executable content still requires authorization. |
| Verified explicit full-component selection | Preserve the declared full selection without an unnecessary partial-selection prompt; keep executable authorization independent. |
| Full source cache survives but requested selection is absent | Cache inventory is not treated as the selected set. Verified installed contents are preserved; other candidates remain unselected. |
| Cache is malformed, installed content is valid | Independently verified installed contents still establish the effective selection. |
| Cache-only unknown selection is renamed | Keep the old payload by default; a publisher rename alone does not authorize replacing it with an empty or broader installation. |
| Both cache and installed evidence fail verification | Leave the old installation unchanged and report that its selection requires review. |
| Only historical release metadata survives | Default action restores no unproven candidates. Explicitly choosing one candidate restores only that candidate. |
| User defers restoration, then repeats update | No repeated question for unchanged evidence, no additional installation or removal, and no false claim of completed historical recovery. |
| User reopens deferred recovery | Candidates remain available for a fresh choice; deferral was not recorded as permanent exclusion. |
| The final installed owner retires with deferred choices still recorded | The selected source remains discoverable, and `update --repair` can restore a chosen candidate. |
| Unknown candidates have multiple current owners | Defer without guessing; later review can select one owner without activating the alternatives. |
| A selected component no longer requires its historical skill dependency | Recompute the closure and do not install that dependency as a directly selected skill in a different plugin. |
| Internal projection rebuild, local refresh or enable with unknown provenance | Preserve verified effective contents and unknown requested provenance; never infer a full choice from the complete cache. |
| Non-interactive update encounters uncertain history | Preserve working contents, report deferral in text and JSON, and continue independent deterministic updates. |
| Partial installation is interrupted before native installation or between hosts | The same update command resumes the recorded selected set, preserves disabled states, and verifies required successors before retirement. |
| Original 46-skill half-update, explicit confirmation of all seven candidates | One `update -g` still reaches 53 skills in all three hosts; the second run reports up to date without native changes. |
| Third-party plugin changes ownership without ADG publisher files | Selection preservation and conservative recovery use ordinary metadata and client history only. |

### Follow-up verification

All 830 ADG tests, type checking and build passed. Focused regressions first
exposed missing conservative defaults, deferred persistence, unknown rename
retirement, source-wide activation of unrelated skills, orphaned deferred
sources, obsolete dependency promotion and internal replay confidence changes.
Each corrected regression passed afterward. Documentation links, test isolation
checks, producer governance and whitespace checks also passed.

Final native acceptance used the same frozen compiled output throughout,
with full-tree SHA-256
`22e569c404d165e2457d234e504342374cea8fb0518a04889d2dbbeaadfdaeec`.

- Original ADG 0.11.4 half-update: one ordinary `update -g` with explicit
  restoration of seven candidates reached ten current plugins and all 53
  skills in real Claude Code, Codex and Antigravity.
- Partial selection: the real 2.2.0 release was installed through the CLI with
  exactly `app-design-evaluation`, `iphone-duo-adoption` and `swift-concurrency`,
  with dependencies explicitly disabled. An ordinary update to 3.0.0 moved
  them to three owners without a restoration prompt. Each host still exposed
  precisely the original three skills.
- Deferred recovery: the original 46-skill half-update accepted the default
  keep action. All hosts retained exactly that 46-skill set and seven unknown
  candidates were recorded as deferred. Repetition stayed quiet. The same
  update with `--repair` reopened those seven choices; explicit restoration
  reached all 53 skills in all hosts and cleared deferred recovery.

All four repeated updates exited successfully, made zero native provider
calls, and left store/runtime contents, permissions and symlink fingerprints
unchanged. Full-source selection, per-plugin partial choices and unknown
provenance remained distinct in the inspected records.

Private acceptance receipts are retained outside the repository. They link
the three scenario runs, recorded commands, native inventories and repeat
fingerprints. Acceptance used isolated homes and replayed published
source transport with no external network access or access to active user
configurations. It verified native registration, discovery and cached skill
contents, without model invocation, hooks or MCP execution.

The final package smoke check passed after installation into a temporary
prefix and exercising both plugin and skill commands. apple-skills required
only updated recovery guidance; its governance check passed with no new ADG
publisher file. Implementation and local acceptance are complete. Publication
follows the repository's reviewed PR and release workflow.

## Delivery review

The subsequent independent delivery review repaired Windows file flushing,
lexical native marketplace identity, explicit Antigravity enablement,
malformed-cache recovery and permission preservation, independent deferred
ownership choices, and requested-versus-derived rename contributions.
Focused regressions reproduced each issue before its fix. Both reviewers then
verified their repaired paths without remaining findings.

Frozen installation with npm 12.2.2, type checking, build and all 843 product
tests passed locally. The real Windows path is covered by the PR's Windows
matrix; local Windows handle tests simulate the required access boundary.
PR checks and subsequent review resolutions bind to the published head.

## Review fixes and regression evidence

| Review item | Implementation and required regression |
| --- | --- |
| P1 1, authorization bypass | Stage the reviewed selection. A skills-only `--all` never activates new hooks. |
| P1 2, partial aliases | Validate every identity before writing. A missing alias leaves its peers unchanged. |
| P1 3, first Claude install interrupted | Confirmed native absence permits activation. Repeat offline and finish. |
| P1 4, dependency hash | Resolve mandatory dependencies consistently for payload integrity. |
| P1 5, incomplete checkpoint | Save all native operations before publishing. Resume between-target interruptions. |
| P1 6, unchanged successor absent | Repair every required successor registration before retirement. |
| P1 7, native disabled state | Carry per-runtime predecessor state through identity changes. |
| P1 8, later linked runtime | Inspect all providers for retirement and install required successors there. |
| P2 9, retry flags | Preserve source, scope, `--all` and repair flags in recovery commands. |
| P2 10, sparse false removal | Fetch the complete current source catalog before deciding that an installed sibling disappeared. |
| P2 11, empty catalog | Keep/drop remains available within update when no candidates remain. |
| P2 12, chain order | Resolve identity chains independently of declaration order. |
| P2 13, producer chains | Remove the proprietary producer validator and exercise native rename chains. |
| P2 14, mismatched schema | Remove the proprietary publisher schema. Third parties add no ADG files. |
| P2 15, cancellation | Text and JSON retain completed source/scope outcomes and exit 130. |
| P2 16, removed lexical alias | Completed receipts remain usable through the canonical store. |
| P2 17, skip wording | Distinguish skipping historical restoration from cancellation. |

Use existing telemetry plumbing for history, planning, authorization and
recovery counts. Exclude historical contents, paths and credentials. Public
regressions use generated fixtures.

## Acceptance

1. Prove authorization and Claude interruption regressions fail before their
   fixes and pass afterward through ordinary command APIs.
2. Restore an isolated private copy of the original ADG 0.11.4 half-update.
   Confirm its 46 distinct skills and retained predecessor.
3. Use the ordinary current apple-skills catalog without ADG migration files.
   Recover historical releases through normal source transport. Run one
   interactive `adg plugins update -g`.
4. Confirm 53 distinct skills, current owners, selected-source intent, and real
   Claude Code, Codex and Antigravity registration/discovery.
5. Repeat the command. Require exit zero, up-to-date output, no historical
   question and no unnecessary native refresh.
6. Exercise ordinary third-party sources with relocation, native `renames`,
   removals and sparse installs. They add no ADG-specific files.
7. Run type checking, build, full ADG tests, producer governance/tests and
   package smoke. Private archives and native evidence stay isolated.

Native acceptance covers registration and discovered/cache skill contents.
Model-session invocation, hooks and MCP execution are separate operations.

## Baseline evidence

Completed on 2026-11-11 against the revised implementation before the partial
selection follow-up above. Its separate acceptance is recorded with that
follow-up. Earlier acceptance
using the withdrawn declaration remains historical evidence only.

- ADG type checking, build and all 794 tests passed. Authorization regressions
  cover skills-only `--all`, effective native dependencies and reviewed
  selections. A regression through the ordinary update API interrupts the
  Claude lifecycle before its first native installation, then resumes offline
  and verifies that the predecessor remains until its successor succeeds.
- Regression coverage also includes all 17 review items above, partial and full
  destination selections, order-independent incoming skill merges, current
  skills preserved during historical restoration, and disabled state carried
  through consecutive renames and splits.
- apple-skills governance and all 255 tests passed. Its final change is README
  guidance for the recovery-capable client. The proprietary declaration,
  producer validator, schema and authoring instructions have been removed.
- Synthetic third-party fixtures exercise skill relocation, existing
  marketplace rename chains, removal and sparse installations without adding
  any ADG-specific publisher files.
- Documentation links and test isolation checks passed. The final package was
  installed in a temporary prefix and exercised through both plugin and skill
  commands; the package smoke check passed.

The final native acceptance started from a fresh isolated copy of the original
ADG 0.11.4 partial update: eight installed plugins and 46 distinct skills. Source
transport replayed the ordinary current catalog and the predecessor's recorded
immutable revision; neither archive contains the withdrawn protocol.

One interactive `adg plugins update -g` confirmed the seven missing historical
skills and completed successfully. Real Claude Code, Codex and Antigravity
discovery each reported ten enabled current plugins with no retired
`apple-platform-guidance` entry. Claude and Codex native caches and Antigravity
discovery each contained all 53 distinct skills. Source intent remained
`selected`.

The second identical command exited successfully, reported all ten plugins
up to date and made no native provider calls. Store and runtime file contents,
permissions and symlink fingerprints were unchanged. The complete compiled
output had SHA-256
`7ac30ef869c88efad7def5d02417524eddd3833f243d5f5a32f6c97859738cbd`
before and after acceptance.

Private logs, native inventories and fingerprints are retained outside the
repository; the acceptance receipts record the checks. Acceptance used isolated
homes and replayed transport, without external network access or changes to
the user's active installations. Native registration, discovery and cache
contents were verified; model invocation, hooks and MCP execution were not
part of this acceptance. Publication and active-user upgrades are tracked
separately.
