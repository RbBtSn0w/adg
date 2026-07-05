# Codex (OpenAI) — Adapter Specification

> Based on the [Agent Adapter Template](../agents-spec.md#7-agent-adapter-template).

---

## 1. Official References

- Plugin docs: <https://code.claude.com/docs/en/plugins-reference> (shared format with Claude)
- Codex shares Claude's plugin schema. Codex-specific behaviors are documented inline.

---

## 2. Projection Output

- Output directory: `.codex-plugin/`
- Manifest file: `.codex-plugin/plugin.json`
- Adapter source: [`src/adapters/codex.ts`](../../src/adapters/codex.ts)

---

## 3. Manifest Schema

Required fields: `name`, `version`, `description`, `skills`

Optional fields: `author`, `homepage`, `license`, `hooks`, `mcpServers`

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
| Skills | ✅ | `skills` (string root or bare-id array) | Auto-scan `skills/` dir; or explicit bare-id array |
| Agents | ❌ | — | Not supported by Codex |
| Commands | ❌ | — | Not supported by Codex |
| Hooks | ✅ | `hooks` | Explicit file path (no auto-load) |
| MCP | ✅ | `mcpServers` | `.mcp.json` path reference |
| Apps | ❌ | — | Not supported by Codex |

---

## 5. Skills

- **Declared form**: String root (`"./skills/"`) or array of **bare ids** (e.g. `["foo", "bar"]`).
- **Strict mode**: Same as Claude. `strict: true` passes root string through; Codex discovers from directory.
- **Array encoding**: **Bare ids** — NOT paths. This is the key difference from Claude.
  ADG resolves `./skills/<id>` paths to bare ids during projection.
- **Auto-discovery**: Codex natively scans a directory root.

---

## 6. MCP Servers

- **Config file name**: Same as Claude (`.mcp.json` reference).
- **Config key**: `mcpServers`
- **Special handling**: Accepts `${CLAUDE_PLUGIN_ROOT}` in configs.

---

## 7. Hooks

- **Canonical file**: Not auto-loaded — requires explicit manifest reference.
- **Native override**: `hooks/hooks-codex.json` — preferred over `hooks/hooks.json`
  when present. Adapter resolution order: `hooks-codex.json` → `hooks.json` → sole `*.json`.
- **Supported events** (10 total):
  `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
  `SubagentStop`, `Stop`
- **Hook types**: `command` (same as Claude)
- **Environment bridging**: Same as Claude (`${CLAUDE_PLUGIN_ROOT}`, etc.).
- **ADG adapter note**: Unlike Claude, Codex has no auto-load. The hooks config must
  be a file path (not a directory). The adapter resolves `./hooks/` to a concrete file.

---

## 8. Environment Variables

Same as Claude — `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`.
