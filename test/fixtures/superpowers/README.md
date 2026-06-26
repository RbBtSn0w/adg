# Fixture: superpowers (vendored, trimmed)

A faithful, offline subset of [obra/superpowers](https://github.com/obra/superpowers) used to pin the
cross-agent (Claude ↔ Codex) compatibility flow for plugins that ship **hooks**.

Vendored **verbatim** (the cross-agent-critical parts):

- `.claude-plugin/plugin.json` — native Claude manifest (no `hooks` field; Claude auto-loads
  `hooks/hooks.json`).
- `.codex-plugin/plugin.json` — native Codex manifest (`hooks: "./hooks/hooks-codex.json"`, `skills`,
  `interface`).
- `hooks/hooks.json` — Claude hook config (`${CLAUDE_PLUGIN_ROOT}`, matcher `startup|clear|compact`).
- `hooks/hooks-codex.json` — Codex hook config (`${PLUGIN_ROOT}`, matcher `startup|resume|clear`).
- `hooks/run-hook.cmd`, `hooks/session-start`, `hooks/session-start-codex` — the real hook scripts.

**Trimmed:** only 3 representative skills (`using-superpowers`, `test-driven-development`,
`systematic-debugging`) instead of the full set — enough to pin the skills contract without bloating the
repo. The plugin's real feature surface is **skills + hooks** (no commands/agents/mcpServers), so this fixture is
faithful to that surface.
