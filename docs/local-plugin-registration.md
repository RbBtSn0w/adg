# Local Plugin Registration

This note documents the supported flow for taking a local directory-source
plugin and making it available in Claude, Codex, and Antigravity through ADG.
Integrators should rely on these commands instead of editing runtime-private
registry files.

## End-to-End Flow

Given a local plugin directory with a canonical `.agents/.plugin.json`:

```bash
adg plugins add <plugin-dir> --global
adg plugins link --target all <plugin-name> --global
```

Use `sync` instead of `link` when you want a clean runtime refresh:

```bash
adg plugins sync --target all <plugin-name> --global
```

Both `link` and `sync` are idempotent and safe to re-run. The recommended
integrator pattern is:

1. Run `add` to copy the directory-source plugin into ADG's store.
2. Run `link` or `sync` for each runtime target that should see the plugin.
3. Re-run `sync` to self-heal runtime drift after updates, manual cleanup, or
   suspected stale runtime caches.

## What `add` Writes

`adg plugins add <plugin-dir> --global` records the plugin in the global ADG
store:

```text
~/.agents/plugins/
├── <plugin-name>/
│   ├── .agents/.plugin.json
│   ├── .claude-plugin/plugin.json
│   ├── .codex-plugin/plugin.json
│   └── ...
├── .plugin-lock.json
├── marketplace.json
└── .claude-plugin/marketplace.json
```

For a local directory source, the lock provenance uses `source.type: "local"`.
The generated marketplace entries make the plugin a member of ADG's local
`adg` marketplace. At this point ADG has stored and adapted the plugin, but a
runtime that keeps its own registry may still need a `link` or `sync` step.

## Claude Registration

Claude Code does not become fully registered just because the plugin exists in
`~/.agents/plugins`. Register it through ADG:

```bash
adg plugins link --target claude <plugin-name> --global
```

or refresh it through ADG:

```bash
adg plugins sync --target claude <plugin-name> --global
```

ADG drives Claude's plugin CLI and lets Claude own its private registry. A
successful registration creates or updates a Claude entry equivalent to:

```json
{
  "plugins": {
    "<plugin-name>@adg": [
      {
        "scope": "user",
        "installPath": "~/.claude/plugins/cache/adg/<plugin-name>/<version>",
        "version": "<version>",
        "installedAt": "<timestamp>",
        "lastUpdated": "<timestamp>"
      }
    ]
  }
}
```

The concrete file is `~/.claude/plugins/installed_plugins.json`, and Claude also
keeps a cached copy under `~/.claude/plugins/cache/adg/<plugin-name>/<version>`.
These paths describe the contract boundary for integrators, but they are
Claude-managed implementation details. Do not hand-edit them; use ADG
`link`/`sync`/`unlink`.

For project installs, the Claude entry uses `scope: "project"` and records a
`projectPath`. For global installs, the entry uses `scope: "user"`.

## Other Runtimes

Codex reads the ADG marketplace export directly from `~/.agents/plugins`, but
`link --target codex` is still the supported way to regenerate projections and
ensure the runtime sees the latest store state.

Antigravity imports from ADG's generated `.antigravity-plugin/` projection.
Use `link --target antigravity` for first registration and `sync --target
antigravity` when you need to clear stale imported components.

## Operational Checks

Use these read commands rather than scraping runtime-private files:

```bash
adg plugins list --global --json
adg plugins status --target claude --global --json
```

`status` reports name-level drift:

- `inSync`: present in both ADG's store and the runtime.
- `missing`: present in ADG's store but not linked into the runtime.
- `agentOnly`: present in the runtime but absent from ADG's store.

Repair drift with:

```bash
adg plugins sync --target <runtime> <plugin-name> --global
```
