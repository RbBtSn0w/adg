# ADG: one source, multiple agents

**Owner:** rbbtsn0w · **Prepared:** 2026-11-21 · **Status:** PR #195 merged;
website and repository preview live; campaign not published · **Review:** D7 and
D14 after the actual first post

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
| [Static walkthrough](../../website/assets/workflow-poster.png) | Visual summary and video poster. |
| [Text transcript](transcript.md) | Commands and captured output, also available as page text on the website. |
| [Social image](../../website/assets/social-preview.png) / [editable SVG](../../website/assets/social-preview.svg) | Repository and website link previews; 1280×640 PNG under 1 MB. |
| [English posts](posts.en.md) / [Chinese posts](posts.zh-CN.md) | Four X drafts each; one language per publication. |
| [Community outline](posts.en.md#community-discussion-outline) | A starting point for an author-written discussion after channel fit is checked. |
| [Capture](capture.json) / [production notes](production.md) | Exact versions, sanitized output, editing, source and reproduction instructions. |

Assets have one owner under `website/assets/`. The README references these same
files. Do not duplicate channel copies or publish raw upstream code as fixtures.

## Live readiness

Website deployment and repository-preview setup completed on 2026-11-21 under
the owner's explicit authorization. Browser verification identified the edge
analytics follow-up below. The [verification receipt](live-readiness.json)
records the source, deployment, public-file hashes and browser results separately
from the original [local production evidence](assets.json).

| Item | Readback / result |
|---|---|
| Integrated source | [PR #195](https://github.com/RbBtSn0w/adg/pull/195), merged as `3d62f696b9268045832bdce2e4cc239a8a5c55ba`. |
| Pages configuration | Existing `adg-marketing` Git integration; production branch corrected from `beta` to `main`; root `website`, empty build command and output path. Automatic production deployments, preview branches and `website/**` watch paths retained. |
| Production deployment | `6da4f993-6d3f-4636-89d5-a888b0744ad7`, successful at 02:07:26 UTC / 10:07:26 Asia/Shanghai; canonical production pointer confirmed. |
| Public website | [adg.rbbtsn0w.me](https://adg.rbbtsn0w.me/) and [deployment URL](https://6da4f993.adg-marketing.pages.dev). HTML, CSS and all six media/icon assets return HTTP 200 with expected MIME types and hashes matching the merged source. |
| Layout and interaction | Chromium at 320, 390, 768 and 1440 pixels: no horizontal page overflow; keyboard skip link, quick-start anchor, FAQ and complete captured text transcript verified. |
| Video | All four widths played the full 10 seconds to completion; 1280×720, native controls, no autoplay, no HTTP or decoding errors. |
| Website link previews | Open Graph and Twitter large-image tags point to the live 1280×640 image. This verifies metadata and image delivery, not X's or Reddit's rendered-card cache. |
| GitHub social preview | Uploaded in repository settings; API reports `usesCustomOpenGraphImage: true`. [Served image](https://repository-images.githubusercontent.com/1272397659/0ae427d7-269d-448d-9068-fc072f3af5ac) is 1280×640, 62,392 bytes, and byte-identical to the committed PNG. |
| Edge analytics finding — deferred | Cloudflare injects a Web Analytics beacon for browser requests; `script-src 'none'` blocks it. Functional checks pass; the console-clean check failed. On 2026-11-21 the owner chose to record the issue and leave analytics settings unchanged. No dashboard login is pending. If revisited, investigate an ADG-only injection exclusion; existing Wrangler access cannot manage RUM rules. |
| Campaign | No X or community post published; D1 has not started. |

The previous production deployment `7b1427c7-3c4b-4256-b55d-b95cd70dbe74`
is the recorded rollback target. [Deployment notes](../../website/README.md)
describe the verified remote settings. A rollback does not require restoring
the retired `beta` production-branch configuration.

## Content schedule

D1 is the actual first publication date, not the preparation date. Posts are
manual, in the author's own voice. Every draft has one principal next action.
Do not publish both languages back-to-back as separate promotions by default.

| Day | Content | Channel / attachment | Owner | State |
|---|---|---|---|---|
| D0 | Review artifacts, verify links and deployment branch, refresh baseline | README, website, repository settings checklist | Author + agent | Deployment, social preview and functional checks complete; analytics finding deferred by owner; author review remains |
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

Baseline refreshed on 2026-11-21 at 02:10:14 UTC (10:10:14 Asia/Shanghai),
using GitHub's rolling 14-day endpoints. Counts match the preparation snapshot;
deployment checks and maintainer visits are not independent trial reports.

| Metric | Baseline | Interpretation |
|---|---:|---|
| Repository views / unique visitors | 34 / 11 | Aggregate reach, not trial completion. |
| Clones / unique cloners | 1,696 / 299 | May include automation; not installs or active users. |
| Independent first-try reports | 0 supplied | The maintainer's demo and the initial X suggestion do not count. |
| Successful reported registration setups | 0 supplied | Target is at least 3 by D14, from the 5 sought reports. |
| Custom GitHub social preview | `true` | Uploaded and verified during live readiness; preparation snapshot was `false`. |

Available referrer aggregates at this checkpoint: `github.com` 6 views / 1 unique
visitor, and `aocr.org` 1 / 1. Referrer uniques must not be added to estimate total
unique visitors. No campaign-attribution or activation claim follows from them.

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
- [x] Cloudflare production branch and deployed commit are read from actual project settings; `main` and merge `3d62f696b9268045832bdce2e4cc239a8a5c55ba` are confirmed in production.
- [x] Website candidate is deployed through an authorized path, with HTTP, assets, MIME types, mobile rendering, playback controls and links verified on the public URL.
- [x] In repository **Settings → Social preview → Edit**, upload `website/assets/social-preview.png`; read back `usesCustomOpenGraphImage: true` and verify the actual preview. The [GitHub requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview) specify PNG/JPG/GIF under 1 MB, with 1280×640 recommended.
- [ ] Refresh D0 baseline, attach the media, publish the selected-language D1 post, and record its real URL/date.
- [ ] If considering a community post, verify channel relevance, participation, current rules, author-written content and affiliation disclosure first.

The website checklist covers delivery and functional checks, all of which passed.
The separate console-clean check failed because of the injected analytics
script; this finding remains recorded and was deferred by the owner on
2026-11-21. Analytics settings and CSP are unchanged, and no login or remediation
is pending in this work. The website's GitHub links to the merged campaign
evidence return HTTP 200. Copy acceptance, a fresh CLI compatibility check and
actual publication remain separate tasks. The compound D1 item is not complete
merely because its baseline was refreshed.

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
