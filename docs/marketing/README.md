# ADG: one source, multiple agents

**Owner:** rbbtsn0w · **Prepared:** 2026-11-21 · **Status:** PR candidate,
campaign not published · **Review:** D7 and D14 after the actual first post

## Objective and audience

Help developers who use both Codex and Claude Code complete a first useful ADG
setup in one project. The main message is:

> One source. Multiple agents. Manage plugins and skills without repeating the setup.

Antigravity is part of the product's supported runtime surface, but not part of
this recording. The first campaign concentrates on the two runtimes actually
verified in the capture. TypeScript is an implementation detail, not the lead
benefit. Paid acquisition and automated posting are outside this first round.

The two-week experiment seeks **five voluntary first-try reports, including at
least three successful installations, connections, and registration checks**.
These are experiment targets, not demonstrated adoption or a condition for
completing the local production work. Interactive discovery in a new agent
session is an additional question, reported separately from registration.

## Evidence and claim boundaries

The initial input was one pasted X comment recommending a 10-second README GIF,
a 1280×640 repository social preview, and r/LocalLLaMA as a channel. The comment's
author, original link, date, product usage, and supporting Reddit demand threads
were not supplied. It is one feedback source, not evidence of repeated demand.

| Message | Evidence | Limit |
|---|---|---|
| Import existing sources | [README examples](../../README.md#works-with-existing-ecosystems); real superpowers import in [capture](capture.json) | Discovery rules vary by source layout. |
| Choose components | Capture selected only `skills` and `brainstorming`; inspected installed skills and native caches | Does not establish every upstream plugin's behavior. |
| Connect Codex and Claude Code | Both real native CLIs report superpowers installed/enabled | No model invocation or interactive skill discovery was tested. |
| Inspect runtime state | Both captured ADG status commands report `in sync (1): superpowers` | Name-level registration only; status does not inspect content drift. |
| Trace installed content | [Lock contract](../agents-spec.md), including source, version, and hash | A lock is not a blanket guarantee of deterministic upstream execution or security. |
| Support Antigravity | [Adapter specification](../agents/antigravity.md) | Component support differs; excluded from this demo's evidence. |

Use "connect", "register", and "inspect" accurately. Do not claim instant
installation, universal runtime parity, automatic continuous synchronization,
zero-copy native installs, measured time savings, local-model integration, user
endorsements, or conversion improvements that have not been verified.

## Deliverables

| Asset | Purpose |
|---|---|
| [README](../../README.md) | Benefit, demo, scoped quick start, then architecture. |
| [Website](../../website/index.html) | Concrete workflow, quick start, compatibility and privacy FAQ. |
| [GIF](../../website/assets/workflow.gif) / [MP4](../../website/assets/workflow.mp4) | 10-second edited replay of real CLI stdout, not a screen recording. |
| [Static walkthrough](../../website/assets/workflow-poster.png) | Accessible alternative and video poster. |
| [Social image](../../website/assets/social-preview.png) / [editable SVG](../../website/assets/social-preview.svg) | Repository and website link previews; 1280×640 PNG under 1 MB. |
| [English posts](posts.en.md) / [Chinese posts](posts.zh-CN.md) | Four X drafts each; one language per publication. |
| [Community outline](posts.en.md#community-discussion-outline) | A starting point for an author-written discussion after channel fit is checked. |
| [Capture](capture.json) / [production notes](production.md) | Exact versions, sanitized output, editing, source and reproduction instructions. |

Assets have one owner under `website/assets/`. The README references these same
files. Do not duplicate channel copies or publish raw upstream code as fixtures.

## Content schedule

D1 is the actual first publication date, not the preparation date. Posts are
manual, in the author's own voice. Every draft has one principal next action.
Do not publish both languages back-to-back as separate promotions by default.

| Day | Content | Channel / attachment | Owner | State |
|---|---|---|---|---|
| D0 | Review artifacts, verify links and deployment branch, refresh baseline | README, website, repository settings checklist | Author + agent | Local preparation |
| D1 | Show the real add → connect → check workflow | X / MP4, with the website as CTA | Author | Draft |
| D4 | Import an existing source and select one skill | X / static walkthrough, quick start as CTA | Author | Draft |
| D7 | Review first-try friction and available traffic data | This brief; revise incorrect claims or blocked steps | Author + agent | Not started |
| D8 | Explain provenance and status boundaries | X / social image, workflow as CTA | Author | Draft |
| D12 | Invite five voluntary first tries and sanitized reports | X / issue link as CTA | Author | Draft |
| D14 | Review trial reports, recurring issues and channel fit | This brief; decide the next two-week topic | Author + agent | Not started |

X is the first distribution channel; README and website receive the traffic.
No paid budget is allocated. A community discussion is optional and does not
replace meaningful participation in that community. r/LocalLLaMA's demand fit
remains unverified. Its [rules](https://old.reddit.com/r/LocalLLaMA/about/rules)
require affiliation disclosure and limit self-promotion, with 10% as a guideline;
they also restrict primarily LLM-generated content. The outline is not an
approved Reddit post: the author must write the actual contribution, check the
current rules, and provide a concrete community-relevant use case first.

## Operating procedure

| Step | Agent responsibility | Author responsibility | Result |
|---|---|---|---|
| Prepare | Verify product claims; produce media and channel-specific drafts | Supply any actual personal experience to include | Reviewable candidate |
| Review | Check links, privacy, dimensions, rendering and commands | Check voice, content accuracy and destination | Accepted content |
| Publish | Prepare exact assets, links and settings checklist | Publish approved content and handle community dialogue | Actual URL and date |
| Follow up | Group sanitized feedback; distinguish defects from new requests | Reply to volunteers; confirm whether a report is complete | Evidence-backed findings |
| Review D7/D14 | Compare available aggregate data; flag missing data | Select the next theme or fix | Updated brief |

Record actual publications below. A calendar entry alone is not proof of a post.
Do not store respondent handles, private logs, email addresses, tokens, or user
identifiers in this public repository. Anonymous report labels are sufficient.

| Post ID | Language | Actual date | Public URL | Asset version | Aggregate result |
|---|---|---|---|---|---|
| — | — | — | — | — | No posts published in this work. |

For each volunteer, ask for the ADG/agent versions, OS, project/global scope,
sanitized command, expected result, observed result, and whether the skill was
discoverable in a new session. An incomplete report remains incomplete. Link a
public issue when the author has chosen to make it public; keep any private
report local. Do not infer five unique people from five anonymous command runs.

## Measurement

Baseline read on 2026-11-21 (Asia/Shanghai), using GitHub's rolling 14-day
endpoints:

| Metric | Baseline | Interpretation |
|---|---:|---|
| Repository views / unique visitors | 34 / 11 | Aggregate reach, not trial completion. |
| Clones / unique cloners | 1,696 / 299 | May include automation; not installs or active users. |
| Independent first-try reports | 0 supplied | The maintainer's demo and the initial X suggestion do not count. |
| Successful reported registration setups | 0 supplied | Target is at least 3 by D14, from the 5 sought reports. |
| Custom GitHub social preview | `false` | Asset is prepared locally; upload remains separate. |

At D0, D7, and D14 record the collection time and available views, clones, and
referrer aggregates. [GitHub traffic](https://docs.github.com/en/rest/metrics/traffic)
retains the recent 14-day window. Overlapping snapshots must not be summed as
new unique visitors. Use daily non-overlapping counts for period comparisons;
retain aggregate snapshots locally if historical analysis is needed. If traffic
permission is unavailable, mark the data unavailable rather than substituting
stars or downloads.

```bash
gh api repos/RbBtSn0w/adg/traffic/views
gh api repos/RbBtSn0w/adg/traffic/clones
gh api repos/RbBtSn0w/adg/traffic/popular/referrers
```

If platform impressions are available, report their source and period separately.
No analytics account or attribution pipeline is being added. Existing anonymous
OTel command totals, if available later, are an aggregate diagnostic signal;
there is no campaign/person correlation or independent activation rate. Record
npm downloads separately if used; they are not verified human adoption.

| Checkpoint | Voluntary reports | Registration confirmed | New-session discovery confirmed | Repeated friction | Next action |
|---|---|---|---|---|---|
| D7 | Not started | Not started | Not started | — | — |
| D14 | Not started | Not started | Not started | — | — |

## Publication checklist

- [ ] Author accepts the copy and verified product claims.
- [ ] Stable package and agent versions remain compatible with the quick start.
- [ ] Cloudflare production branch and deployed commit are read from actual project settings; `main` is the intended integration branch, not proof of deployed configuration.
- [ ] Website candidate is deployed through an authorized path, with HTTP, assets, MIME types, mobile rendering, playback controls and links verified on the public URL.
- [ ] In repository **Settings → Social preview → Edit**, upload `website/assets/social-preview.png`; read back `usesCustomOpenGraphImage: true` and verify the actual preview. The [GitHub requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) specify PNG/JPG/GIF under 1 MB, with 1280×640 recommended.
- [ ] Refresh D0 baseline, attach the media, publish the selected-language D1 post, and record its real URL/date.
- [ ] If considering a community post, verify channel relevance, participation, current rules, author-written content and affiliation disclosure first.

These boxes intentionally remain unchecked: production, repository settings and
social accounts were not changed during local preparation. The website's new
GitHub `main` links to campaign evidence become valid when these files are
integrated; verify them again before public distribution.

## Exceptions

If the stable CLI or upstream source changes, redo the isolated capture and
update the evidence and derivative assets together. If a native CLI fails, keep
the failure local and fix the actual recording prerequisite; do not invent a
success output. If a user reports drift, collect the targeted runtime's status
and follow the [update/recovery guide](../plugin-upgrade-migrations.md); do not
recommend destructive cleanup as a generic workaround.

If the first week produces little traffic, first verify that the posts and
landing links actually exist, then improve the hook or next action. Do not
interpret a small sample as proof of channel failure or product-market fit.
