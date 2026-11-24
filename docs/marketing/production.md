# Media production and verification

Prepared on 2026-11-21. The [campaign brief](README.md) owns publication status;
this file describes how the assets were made and what their evidence proves.

## Capture inputs

| Input | Verified value |
|---|---|
| ADG | npm stable `@rbbtsn0w/adg@1.0.2`, installed only in a temporary prefix |
| npm package integrity | `sha512-5iWqjWPt9aA555bBGH5/c5lrO+B6EKGzQ+E2gIUzW8NMyXh5IiKn6AVf5Xxx7Qvk7+mCzzTCZWm16S94j7KQFw==` |
| Node.js | 24.22.2 |
| Codex | `codex-cli 0.167.2` |
| Claude Code | `2.1.312` |
| Public source | [obra/superpowers](https://github.com/obra/superpowers), MIT, visibility verified through GitHub API |
| Source revision | `22f0b463e7a5e579904dd6211a520321035526f7` |
| Plugin version | 7.0.2 |
| Selection | `--only skills --skill brainstorming` |
| Scope | `--project` throughout |

No upstream skill source, archive, or font binary was copied into this repository.
The public assets contain product names, CLI output, and original typography.
The source license is recorded to establish provenance, not imply endorsement.

The demo was executed with real agent CLIs in temporary configuration homes.
The capture process supplied child-process environment overrides for
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `GEMINI_HOME`; each pointed to its own
throwaway directory. It also isolated `ADG_PLUGINS_HOME`, `ADG_CACHE_HOME`, and
`ADG_MUTEX_HOME`. The mutation mutex directory was explicitly mode `0700`.
No shell profile, real agent config, credential, or global installation was used
or edited to prepare this environment. This isolation is a capture precaution,
not a claim that ordinary project-scoped installation is a security sandbox.

`DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1`, and `OTEL_SDK_DISABLED=true` disabled
capture traffic. No new CLI API, subprocess wrapper, collection field, visitor
identifier, or website analytics SDK was added for this campaign. Existing
product OTel behavior is unchanged.

## Actual commands and evidence

The exact commands, durations, exit codes, stdout, and stderr are preserved in
[capture.json](capture.json). All nine recorded commands exited zero. In order:

1. Read ADG, Codex and Claude Code versions.
2. Add superpowers at the fixed revision, selecting only the brainstorming skill
   and activating Codex in project scope.
3. Link that project store to Claude Code.
4. Read ADG status separately for Codex and Claude Code.
5. Read both native CLIs' JSON plugin lists.

Both native lists identified `superpowers@adg-94d92dcc` version 7.0.2 as enabled;
Codex also reported `installed: true`, and Claude reported `scope: project`.
The name suffix is derived from the temporary store and will vary in another
capture. Both ADG checks returned `in sync (1): superpowers` and explicitly
warned that content drift was not inspected.

The managed payload and both native cache trees were independently inspected:
each contained exactly one `SKILL.md`, under `brainstorming`. SHA-256 comparisons
of the real Codex config and Claude settings/plugin registry files before and
after the run were equal. This was a scoped config check, not a complete
snapshot of unrelated user data or concurrently running applications.

Model execution, interactive picker appearance, and skill discovery inside a
new session were **not** tested. Antigravity was not included in the capture.
These limits appear in the public walkthrough as well.

## Editing and source files

The media are **typeset replays of real stdout, not terminal screen recordings**.
Temporary root paths were replaced with `<DEMO>`. Commands were wrapped for
readability; stdout wording, including status limitations, was preserved. The
poster explicitly presents selected output, and does not represent a full log.
Raw machine paths, usernames, private repository names and tokens are absent.

| Source | Hold time | Material |
|---|---:|---|
| [workflow-01.svg](source/workflow-01.svg) | 3.5 s | Actual add command and stdout |
| [workflow-02.svg](source/workflow-02.svg) | 2.5 s | Actual Claude link command and stdout |
| [workflow-03.svg](source/workflow-03.svg) | 4.0 s | Both actual status commands and complete stdout |
| [workflow-poster.svg](source/workflow-poster.svg) | Static | Overview with selected real output |
| [social-preview.svg](../../website/assets/social-preview.svg) | Static | Original share illustration; product support, not a recording result |

[The timeline](source/timeline.json) is the editing source of truth. The GIF
loops across three held frames; the silent MP4 uses the same cuts at 24 fps.
There is no synthesized typing or invented native app UI. The website uses
native controls and a static poster without autoplay, with the commands and
stdout in a native transcript disclosure beside the figure. The README links
the poster, MP4 and [text transcript](transcript.md) beside its GIF.

The sources use Arial and Menlo with generic fallbacks; fonts are not bundled.
Native fonts and renderer versions can change antialiasing, so regenerated
assets should be inspected rather than expected to have identical hashes.

## Reproduce the exports

The exports were rendered with Python 3.13.12, Pillow 13.0.0, CairoSVG 2.9.1,
Homebrew Cairo 1.18.6, and FFmpeg 9.0.2. These are local production tools, not ADG runtime
dependencies. Do not change package manifests or lockfiles to install them.
Quick Look thumbnails are unsuitable: its tested SVG export clipped the source
into a square, so it was not used for the delivered assets.

From the repository root, create a temporary tools environment if needed:

```bash
render_root=$(mktemp -d)
python3 -m venv "$render_root/venv"
"$render_root/venv/bin/pip" install 'CairoSVG==2.9.1' 'Pillow==13.0.0'
# CairoSVG also needs the system Cairo library; Homebrew Cairo was used here.
```

Rasterize the editable sources and recreate the GIF. Set `ADG_RENDER_DIR` only
for this rendering process:

```bash
ADG_RENDER_DIR="$render_root" "$render_root/venv/bin/python" - <<'PY'
from pathlib import Path
import json
import os
import cairosvg
from PIL import Image

out = Path(os.environ['ADG_RENDER_DIR'])
timeline = json.loads(Path('docs/marketing/source/timeline.json').read_text())
frames = []
durations = []
for index, entry in enumerate(timeline['frames'], 1):
    png = out / f'workflow-{index:02}.png'
    cairosvg.svg2png(url=f"docs/marketing/source/{entry['source']}",
                    write_to=str(png), output_width=1280, output_height=720)
    frames.append(Image.open(png).convert('RGB'))
    durations.append(round(entry['durationSeconds'] * 1000))
frames[0].save('website/assets/workflow.gif', save_all=True,
               append_images=frames[1:], duration=durations, loop=0, optimize=True)
for source, target, height in [
    ('docs/marketing/source/workflow-poster.svg', 'workflow-poster.png', 720),
    ('website/assets/social-preview.svg', 'social-preview.png', 640),
]:
    cairosvg.svg2png(url=source, write_to=f'website/assets/{target}',
                    output_width=1280, output_height=height)
lines = ['ffconcat version 1.0']
for index, entry in enumerate(timeline['frames'], 1):
    lines += [f"file 'workflow-{index:02}.png'", f"duration {entry['durationSeconds']}"]
lines.append(f"file 'workflow-{len(frames):02}.png'")
(out / 'timeline.ffconcat').write_text('\n'.join(lines) + '\n')
PY
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 \
  -i "$render_root/timeline.ffconcat" -t 10 -vf fps=24 \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart -an \
  website/assets/workflow.mp4
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_name,width,height -of json website/assets/workflow.mp4
```

To redo the capture, first verify the stable npm dist-tag and source visibility
and license. Use the exact pinned revision and command list from the JSON, and
pass the isolated configuration/cache/mutex overrides described above to every
ADG **and native agent** subprocess. Inspect both native lists and the actual
selected payload before regenerating the sources. Never point the capture at a
real profile to work around an isolation failure.

## Local verification

Final measurements, artifact SHA-256 hashes and validation outcomes are recorded
in [assets.json](assets.json).

| Check | Result |
|---|---|
| Real stable CLI capture | All 9 commands exited zero; native registration enabled in both runtimes. |
| Selected payload | Exactly one brainstorming skill in the store and both native caches. |
| Media | GIF 1280×720 / 10 s / 111,247 bytes; H.264 MP4 1280×720 / 24 fps / 10 s / 119,761 bytes, no audio. |
| Social image | PNG 1280×640 / 62,392 bytes, opaque background; editable SVG retained. |
| Documented export procedure | Executed as written with the installed temporary tools; identical hashes for every exported asset. |
| Browser | Isolated headless Chromium 157.0.8103.51 via Playwright 1.65.1, authorized after CUA browser connections were unavailable. |
| Responsive behavior | 320, 390, 768 and 1440 px: no horizontal overflow; skip link, CTA anchor and native FAQ toggle checked. |
| CSP and video | Production CSP applied in the local preview; complete playback to the 10-second `ended` state, no HTTP or decoder errors. |
| Copy | Four posts per language; each has estimated X weighted length under 280. |
| Documentation | `npm run check:docs`: 20 Markdown files; separate check resolved 71 local targets across all 7 changed Markdown files. |
| Initial PR preflight | `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm run build`, and `npm test` passed on Node 24.22.2 / npm 12.2.2; all 948 tests passed, none skipped. |
| Independent review | No actionable correctness, safety, or regression findings. |

Chromium intentionally cancelled its initial `preload="metadata"` request after
reading metadata (`readyState: 4`, duration 10, no media error), then resumed a
206 byte range on playback. The initial harness's zero-cancellations assertion
therefore failed despite successful layout and playback checks. A targeted
network-event diagnostic and complete playback check established the cause;
cancellation was not silently discarded as a successful HTTP response. The
favicon's initial missing-resource response was fixed with an original local
SVG; the final playback check reported no console or HTTP errors.

The initial PR preflight at `bbca63d` completed on 2026-11-21 with a clean dependency
installation and the full CLI suite: 948 passed, 0 failed, and 0 skipped. Test
telemetry was disabled. CLI source, dependency manifests and lockfiles are
unchanged. The campaign's external publication checklist remains separate:
valid source files and a reviewable PR do not prove the website is deployed or
a repository setting has changed.

### Review follow-up validation

The replay's full commands and stdout now appear in a Markdown transcript and
in a native HTML disclosure beside the figure. Both representations were
compared exactly with `capture.json`. At 320, 390, 768 and 1440 px, the disclosure
expanded, its output appeared in the accessibility tree, and the code blocks
accepted keyboard focus without causing horizontal page overflow. No HTTP or
console errors were observed. The static images and video were not changed.

The monorepo guidance was checked against native-manifest scanning and source
normalization. `node scripts/run-tests.mjs test/sources.test.ts
test/normalizer.test.ts` passed all 37 tests. `npm run check:docs` passed for 20
Markdown files. The full-suite result above belongs to the initial PR preflight;
this documentation-only follow-up uses focused checks and the updated PR's CI.
