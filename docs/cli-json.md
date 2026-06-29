# CLI JSON Output Contract

ADG exposes stable JSON output for read-only plugin commands so external tools
can integrate over the CLI boundary without scraping human-formatted text.

## General Contract

- Supported commands in this contract:
  - `adg plugins list --json`
  - `adg plugins status --json`
- On success, stdout contains exactly one valid JSON document and no human
  formatting, ANSI color, notes, or tips.
- On failure, diagnostics are written to stderr and the process exits non-zero.
  JSON error envelopes are not part of this contract.
- Existing fields documented here are stable. Future releases may add fields;
  callers should ignore unknown fields.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded; stdout is complete and parseable. |
| `1` | Invalid arguments, missing required input, validation/runtime error, unknown option, or command failure. |

## `adg plugins list --json`

Shape:

```json
{
  "pluginsDir": "/absolute/path/to/.agents/plugins",
  "plugins": [
    {
      "name": "apple-skills",
      "version": "1.13.2",
      "source": { "type": "github", "repo": "RbBtSn0w/apple-skills" },
      "folderHash": "sha256-...",
      "installedAt": "2026-06-26T00:00:00.000Z",
      "updatedAt": "2026-06-26T00:00:00.000Z",
      "path": "/absolute/path/to/.agents/plugins/RbBtSn0w__apple-skills/apple-skills",
      "agents": ["claude", "codex", "antigravity"],
      "contents": {
        "skills": ["xcode-build-fixer"],
        "agents": [],
        "commands": [],
        "mcp": ["xcode"],
        "hooks": [],
        "apps": []
      },
      "counts": {
        "skills": 1,
        "agents": 0,
        "commands": 0,
        "mcp": 1,
        "hooks": 0,
        "apps": 0
      },
      "partial": false
    }
  ]
}
```

Field notes:

- `pluginsDir` and each `path` are absolute filesystem paths.
- `source` is ADG's lock-file provenance object.
- `agents` contains stable agent ids, not display names.
- `contents` always includes every component category, using empty arrays when a
  plugin has none of that category.
- `counts` mirrors `contents` lengths.
- `partial` is true when the installed plugin has a stored partial-install
  selection.

## `adg plugins status --json`

Shape:

```json
{
  "pluginsDir": "/absolute/path/to/.agents/plugins",
  "scope": "user",
  "targets": ["claude"],
  "statuses": [
    {
      "id": "claude",
      "displayName": "Claude Code",
      "queryable": true,
      "inSync": ["apple-skills"],
      "missing": [],
      "agentOnly": []
    }
  ]
}
```

Field notes:

- `scope` is the agent install scope: `user` for `--global`, otherwise
  `project`.
- `targets` contains the resolved target ids requested by `--target`; omitted
  `--target` resolves to all registered targets.
- `queryable: false` means the agent CLI could not be queried; the arrays are
  then empty because live state is unknown. When the CLI ran but rejected the
  query, `queryError` contains its diagnostic and `recoveryCommand` contains a
  safe repair command when ADG recognizes the failure. Both fields are omitted
  when unavailable.
- `inSync`, `missing`, and `agentOnly` are name-level comparisons. Content drift
  is not represented; use `adg plugins sync` when a full runtime refresh is
  required.
