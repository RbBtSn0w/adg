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

Codex discovers ADG's marketplace, but loads plugins only after runtime
registration through its CLI. Use `link --target codex` for registration and
`sync --target codex` for a complete refresh.

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

## Persistent Disablement

Use store-level disablement when a plugin should remain installed and updateable
without being loaded by any runtime:

```bash
adg plugins disable <plugin-name> --global
adg plugins enable <plugin-name> --global
```

`disable` keeps the payload and marketplace catalog entry in ADG's store, records
the desired state in `.plugin-lock.json`, and removes the plugin from every
registered runtime. `enable` restores disabled dependencies first, regenerates
runtime projections, and activates the plugin in each compatible runtime.

`unlink --target <runtime>` is different: it is a temporary per-runtime override
and does not change store state. A later `sync` restores the store's enabled or
disabled state. `remove` deletes the payload and catalog entry entirely.

## Codex Registration Recovery

`adg plugins status --target codex --global --json` preserves the existing
`missing` field and adds `runtimeMissing` (not installed) and `runtimeDisabled`
(installed but disabled). Queries do not rewrite the catalog or Codex config.
Query failures mean unknown state, not an empty installation.

Use `adg plugins enable <name> --global` to explicitly restore an enabled plugin,
including a missing registration or runtime disablement. Healthy registrations
are not reinstalled. `adg plugins update --global --repair` updates sources and
then repairs missing Codex registrations using the existing local snapshots;
it preserves runtime-disabled plugins even when their source changes. Enabled
plugins whose contents changed are refreshed through the same verified execution
plan. Ordinary `update` does not repair an
intentional `unlink`. `sync` explicitly reconciles the complete desired state.

Repair honors stored component selections and dependencies. Installation and
verification failures are reported individually; partial failure exits nonzero
without rolling back successful installations. Other runtimes retain their
existing behavior. CLI diagnostics are local output, not telemetry payloads.

### Official Account Switch Investigation

The relationship between official Codex account switching and registration
loss is unconfirmed. Capture scoped plugin status before switching, immediately
after switching, after restarting and opening a new conversation, and after
explicit repair. Compare only ADG plugin/marketplace settings and cache presence;
keep any config backup private and redact paths in shared evidence. Never collect
`auth.json`, credentials, account identifiers, or raw config in telemetry.
Registration recovery does not guarantee that an existing desktop conversation
refreshes its skills; verify discovery in a new conversation.

In repair mode, Codex state is observed before source updates. Other runtimes
retain their normal update behavior; Codex writes are deferred until a scoped
plan is ready. An unavailable snapshot allows source materialization but blocks
Codex installation, refresh, and cleanup, producing a nonzero result.

Dependencies are processed first. A dependency outside the selected scope is
checked, not automatically installed; unavailable or failed dependencies block
their dependents while independent plugins continue. Explicit `enable` includes
its dependency closure. Execution success and post-operation verification are
reported separately: an unverified installation is never displayed as enabled.
