# Claude (Anthropic) — Adapter Specification

> Based on the [Agent Adapter Template](../agents-spec.md#7-agent-adapter-template).

---

## 1. Official References

- Plugin docs: <https://code.claude.com/docs/en/plugins-reference>
- Standard plugin layout: <https://code.claude.com/docs/en/plugins-reference#standard-plugin-layout>
- File locations reference: <https://code.claude.com/docs/en/plugins-reference#file-locations-reference>
- Manifest schema: <https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema>
- Hooks reference: <https://code.claude.com/docs/en/hooks>

---

## 2. Projection Output

- Output directory: `.claude-plugin/`
- Manifest file: `.claude-plugin/plugin.json`
- Adapter source: [`src/adapters/anthropic.ts`](../../src/adapters/anthropic.ts)

---

## 3. Manifest Schema

Required fields: `name`

Optional fields: `version`, `description`, `author`, `homepage`, `license`,
`category`, `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `apps`,
`strict`, `displayName`, `repository`, `keywords`, `outputStyles`,
`lspServers`, `dependencies`, `userConfig`, `channels`,
`experimental.themes`, `experimental.monitors`

```jsonc
// Minimal projected manifest
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Example plugin",
  "skills": "./skills/"
}
```

---

## 4. Supported Components

| Component | Supported | Manifest Key | Discovery Mechanism |
| :--- | :---: | :--- | :--- |
| Skills | ✅ | `skills` (string root or `./skills/<id>` path array) | Auto-scan `skills/` dir for sub-dirs with `SKILL.md`; or explicit path array |
| Agents | ✅ | `agents` | Markdown files in `agents/` dir |
| Commands | ✅ | `commands` | Markdown files in `commands/` dir |
| Hooks | ✅ | `hooks` | `hooks/hooks.json` (auto-loaded); explicit file path |
| MCP | ✅ | `mcpServers` | `.mcp.json` or inline in manifest |
| Apps | ✅ | `apps` | App directory |
| LSP | ✅ | `lspServers` | `.lsp.json` or inline (Claude-only, not in ADG) |
| Monitors | ✅ | `experimental.monitors` | `monitors/monitors.json` (Claude-only, not in ADG) |
| Themes | ✅ | `experimental.themes` | `themes/` dir (Claude-only, not in ADG) |

---

## 5. Skills

- **Declared form**: String root (`"./skills/"`) or array of `./skills/<id>` paths.
- **Strict mode**: `strict: true` (default) = runtime discovers skills from directory.
  `strict: false` = manifest enumerates all skills explicitly.
- **Array encoding**: Paths in `./skills/<name>` form (not bare ids).
- **Auto-discovery**: When `strict: true` and skills is a root string, Claude scans
  the directory. A strict array is passed through verbatim.
- **Root SKILL.md**: A single `SKILL.md` at plugin root is loaded as a single-skill
  plugin when no `skills/` dir exists and no `skills` key is declared.

---

## 6. MCP Servers

- **Config file name**: `.mcp.json` (or inline in manifest under `mcpServers`)
- **Config key**: `mcpServers`
- **Special handling**: Supports `${CLAUDE_PLUGIN_ROOT}` substitution in command/args/env.

---

## 7. Hooks

- **Canonical file**: `hooks/hooks.json` — **auto-loaded** by Claude runtime.
- **Native override**: N/A (Claude is the canonical format author).
- **Codex-specific override**: `hooks/hooks-codex.json` — different behavior per agent.
- **Supported events** (30 total):
  `SessionStart`, `Setup`, `SessionEnd`, `UserPromptSubmit`, `UserPromptExpansion`,
  `Stop`, `StopFailure`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PostToolBatch`, `PermissionRequest`, `PermissionDenied`, `SubagentStart`,
  `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`,
  `InstructionsLoaded`, `ConfigChange`, `FileChanged`, `CwdChanged`,
  `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`,
  `Elicitation`, `ElicitationResult`, `Notification`, `MessageDisplay`
- **Hook types**: `command`, `http`, `mcp_tool`, `prompt`, `agent`
- **Environment bridging**: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${CLAUDE_PROJECT_DIR}`, `${user_config.*}`.
- **ADG adapter note**: The standard `hooks/hooks.json` is auto-loaded by Claude.
  The adapter MUST NOT repeat this path in the projected manifest, or Claude fails
  with "Duplicate hooks file detected". Only _additional_ hook files are declared.

---

## 8. Environment Variables

| Variable | Description |
| :--- | :--- |
| `${CLAUDE_PLUGIN_ROOT}` | Absolute path to the plugin installation directory. |
| `${CLAUDE_PLUGIN_DATA}` | Persistent data directory surviving updates. |
| `${CLAUDE_PROJECT_DIR}` | Current working directory of the project. |
| `${user_config.*}` | User-configured values from `userConfig` fields. |
