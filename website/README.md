# ADG marketing site

This directory is a dependency-free static site intended for Cloudflare Pages.

## Cloudflare Pages

- **Framework preset:** None
- **Build command:** None
- **Output directory:** `website`
- **Integration branch:** `main`
- **Cloudflare production branch:** verify in the Pages project before publishing
- **Production URL:** `https://adg.rbbtsn0w.me/`

The custom domain is configured in Cloudflare Pages, not in this repository.
After creating the Pages project, attach `adg.rbbtsn0w.me` under **Custom
domains** and point the DNS record at the Pages project as Cloudflare directs.

Previous documentation named `beta` as the production branch. That value has
not been verified against Cloudflare. The repository integrates on `main`;
that does not prove the remotely configured Pages production branch.
The live site returned HTTP 200 on 2026-11-21, but Cloudflare's project settings
were not available for verification. Before publication, read the project's
Git Integration settings and record the production branch and deployed commit.
If a branch change is needed, present that remote change for authorization.

For an authorized Git Integration setup, connect `RbBtSn0w/adg` in **Workers &
Pages > Create application > Pages > Connect to Git**, use `main` as the intended
production branch, leave the framework preset and build command empty, set the
output directory to `website`, and keep preview deployments enabled for pull
requests. Do not change an existing deployment based on this example alone.

## Local preview and assets

Serve the repository root to check both the website and its documentation links:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765/website/
```

The site is static, has no analytics script, and retains `script-src 'none'`.
Its video uses native playback controls, a poster, and no autoplay. All media
are same-origin. The [campaign brief](../docs/marketing/README.md) owns the
capture evidence, asset production instructions, publishing checklist, and
two-week content schedule. Assets under `assets/` are shared with the root
README; do not make separate copies for each channel.
