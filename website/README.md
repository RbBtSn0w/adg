# ADG marketing site

This directory is a dependency-free static site intended for Cloudflare Pages.

## Cloudflare Pages

- **Project:** `adg-marketing`
- **Git repository:** `RbBtSn0w/adg`
- **Framework preset:** None
- **Root directory:** `website`
- **Build command:** Empty (no build step)
- **Output directory:** Empty (serve the root directory above)
- **Local Wrangler output directory:** `./website`, relative to the repository root
- **Integration branch:** `main`
- **Cloudflare production branch:** `main`
- **Production URL:** `https://adg.rbbtsn0w.me/`
- **Automatic production deployments:** Enabled
- **Preview branches:** All
- **Build watch paths:** `website/**`

These values were read back from the existing Git-connected Pages project on
2026-11-21. The custom domain is already attached. The Git integration's root
directory and empty output setting serve `website`; do not also enter `website`
as an output path beneath that root.

The production branch was still `beta`, serving a 2026-09-03 deployment. With
the owner's deployment authorization, it was changed to `main` without changing
the domain, build settings, preview behavior, or watch paths. A deployment was
then triggered through the existing Git integration:

- **Source:** PR #195 merge, `3d62f696b9268045832bdce2e4cc239a8a5c55ba`
- **Production deployment:** `6da4f993-6d3f-4636-89d5-a888b0744ad7`
- **Deployment URL:** <https://6da4f993.adg-marketing.pages.dev>
- **Completed:** 2026-11-21 02:07:26 UTC (10:07:26 Asia/Shanghai)
- **Result:** All deployment stages succeeded; the project points its canonical
  production deployment at this version.

The previous production deployment, `7b1427c7-3c4b-4256-b55d-b95cd70dbe74`
(`1f1003e96d548eabd28067e11d90f0906f0c2c68`), is the recorded rollback target.
Use the Pages deployment rollback control if a rollback is needed; changing the
production branch is a separate configuration decision.

See the [operations ledger](../docs/marketing/README.md#live-readiness) and
[verification receipt](../docs/marketing/live-readiness.json) for public-file
hashes, browser checks, social-preview readback, and the deferred analytics finding.

## Local preview and assets

Serve the repository root to check both the website and its documentation links:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765/website/
```

The static source has no analytics script and retains `script-src 'none'`.
Cloudflare's edge-injected Web Analytics beacon is blocked by that policy. On
2026-11-21 the owner chose to record the console finding and defer any analytics
setting changes; no dashboard login is pending.
Its video uses native playback controls, a poster, and no autoplay. All media
are same-origin. The [campaign brief](../docs/marketing/README.md) owns the
capture evidence, asset production instructions, publishing checklist, and
two-week content schedule. Assets under `assets/` are shared with the root
README; do not make separate copies for each channel.
