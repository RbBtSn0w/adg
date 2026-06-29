# Antigravity (Gemini / agy) — Adapter Specification

> Based on the [Agent Adapter Template](../agents-spec.md#7-agent-adapter-template).

---

## 1. Official References

- Plugin docs: <https://antigravity.google/docs/cli/plugins>
- **Note**: Antigravity has a convention-based discovery model. There is no rich
  manifest schema — plugins are discovered by directory structure and file presence.

---

## 2. Projection Output

- Output directory: Plugin root (no subdirectory)
- Manifest file: `plugin.json` (at plugin root)
- MCP config: `mcp_config.json` (at plugin root, copied from source `.mcp.json`)
- Hooks config: `hooks.json` (at plugin root, translated from canonical format)
- Runner script: `.antigravity-plugin/hook-runner.mjs` (generated bridge)
- Adapter source: [`src/adapters/antigravity.ts`](../../src/adapters/antigravity.ts),
  [`src/adapters/antigravity-hooks.ts`](../../src/adapters/antigravity-hooks.ts)

---

## 3. Manifest Schema

Required fields: `name` only.

The projected `plugin.json` contains **only the plugin name**. All other metadata
is discovered by convention (presence of sibling directories/files).

```jsonc
// Projected plugin.json — minimal by design
{ "name": "my-plugin" }
```

---

## 4. Supported Components

| Component | Supported | Manifest Key | Discovery Mechanism |
| :--- | :---: | :--- | :--- |
| Skills | ✅ | — | Auto-scan `skills/` dir for sub-dirs with `SKILL.md` |
| Agents | ✅ | — | Auto-scan `agents/` dir |
| Commands | ✅ | — | Auto-scan `commands/` dir |
| Hooks | ✅ | — | Root `hooks.json` file (native schema) |
| MCP | ✅ | — | Root `mcp_config.json` file |
| Apps | ❌ | — | Not supported by Antigravity |

**Key difference**: Antigravity does NOT read the manifest for component paths.
It discovers components purely by scanning known directory names and file names at the
plugin root. The ADG adapter materializes files at these conventional locations.

---

## 5. Skills

- **Declared form**: No manifest field. Antigravity scans `skills/` at the plugin root.
- **Strict mode**: N/A — always auto-discovers. No explicit skill list in manifest.
- **Array encoding**: N/A — not declared in manifest.
- **Auto-discovery**: Scans `skills/` for sub-dirs containing `SKILL.md`. Each sub-dir's
  `SKILL.md` YAML frontmatter provides `name` and `description`.
- **SKILL.md structure**: Identical across all agents:
  ```
  skills/<name>/
  └── SKILL.md          # Required: YAML frontmatter (name, description) + body
  ```

---

## 6. MCP Servers

- **Config file name**: `mcp_config.json` (at plugin root — required conventional name).
- **Config key**: N/A (no manifest key; discovered by file presence).
- **Special handling**: ADG copies (or symlinks) the source `.mcp.json` to
  `mcp_config.json` at the plugin root. If the source IS already `mcp_config.json`,
  no copy is performed.

---

## 7. Hooks

- **Canonical file**: Root `hooks.json` — Antigravity's only hook discovery point.
- **Native override**: `hooks/hooks-antigravity.json` — validated and copied verbatim,
  bypassing Claude-to-Antigravity translation.
- **Supported events** (4 total):
  `PreInvocation` (← SessionStart), `PreToolUse`, `PostToolUse`, `Stop`
- **Event mapping** (Claude → Antigravity):

  | Claude Event | Antigravity Event | Notes |
  | :--- | :--- | :--- |
  | `SessionStart` | `PreInvocation` | Only fires when `invocationNum === 0` (runner filters) |
  | `PreToolUse` | `PreToolUse` | Tool groups with matcher |
  | `PostToolUse` | `PostToolUse` | Tool groups with matcher |
  | `Stop` | `Stop` | Direct event |

- **Tool name aliases** (Claude → Antigravity):

  | Claude Tool | Antigravity Tool(s) |
  | :--- | :--- |
  | `Bash` | `run_command` |
  | `Read` | `view_file` |
  | `Write` | `write_to_file` |
  | `Edit` | `replace_file_content`, `multi_replace_file_content` |
  | `Glob` | `find_by_name` |
  | `Grep` | `grep_search` |
  | `WebSearch` | `search_web` |
  | `WebFetch` | `read_url_content` |
  | `Agent` | `invoke_subagent` |
  | `AskUserQuestion` | `ask_question` |

- **Hook types**: `command` only (`type: "command"` is the sole supported type).
  `async: true` handlers are NOT supported and produce a warning.
- **Native hooks schema** (Antigravity-native format):
  ```jsonc
  {
    "<hookName>": {
      "enabled": true,             // optional boolean
      "PreInvocation": [           // direct events: handler array
        { "type": "command", "command": "...", "timeout": 30 }
      ],
      "PreToolUse": [              // tool events: group array
        { "matcher": "run_command", "hooks": [
            { "type": "command", "command": "...", "timeout": 30 }
          ]
        }
      ]
    }
  }
  ```
- **Environment bridging**: The generated `hook-runner.mjs` translates:
  - `${CLAUDE_PLUGIN_ROOT}` / `${PLUGIN_ROOT}` → absolute plugin path
  - Antigravity stdin JSON → Claude-format input fields
  - Claude-format output → Antigravity decision output (`allow`/`deny`/`ask`/`stop`)

---

## 8. Environment Variables

| Variable | Description |
| :--- | :--- |
| `CLAUDE_PLUGIN_ROOT` | Set by hook-runner bridge to the absolute plugin directory. |
| `PLUGIN_ROOT` | Alias for `CLAUDE_PLUGIN_ROOT`. |

**Note**: These are injected by the generated `hook-runner.mjs`, not by the Antigravity
runtime itself. The runner bridges Claude-format command scripts to Antigravity's I/O.
