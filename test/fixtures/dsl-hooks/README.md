# Fixture: dsl-hooks

A plugin authored with the ADG universal hooks DSL (`.agents/hooks.json`,
`adg.hooks/v1`). Used to pin the forward compile path: one universal source →
`hooks/hooks.json` (Claude, `${CLAUDE_PLUGIN_ROOT}`) + `hooks/hooks-codex.json`
(Codex, `${PLUGIN_ROOT}`), with per-target matcher/command overrides.
