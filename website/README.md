# ADG marketing site

This directory is a dependency-free static site intended for Cloudflare Pages.

## Cloudflare Pages

- **Framework preset:** None
- **Build command:** None
- **Output directory:** `website`
- **Production branch:** `beta`
- **Production URL:** `https://adg.rbbtsn0w.me/`

The custom domain is configured in Cloudflare Pages, not in this repository.
After creating the Pages project, attach `adg.rbbtsn0w.me` under **Custom
domains** and point the DNS record at the Pages project as Cloudflare directs.

For Git Integration, connect `RbBtSn0w/adg` in **Workers & Pages > Create
application > Pages > Connect to Git**, choose `beta` as the production branch,
leave the framework preset and build command empty, set the output directory to
`website`, and keep preview deployments enabled for pull requests.
