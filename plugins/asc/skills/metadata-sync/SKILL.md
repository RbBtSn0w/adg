---
name: metadata-sync
description: Pull and push canonical App Store metadata (description, keywords, what's new).
---

# metadata-sync

Use when synchronizing App Store listing metadata between the repo and App Store Connect.

1. Pull current metadata into `./metadata`.
2. Diff against the canonical source.
3. Push approved changes back via the ASC API.
