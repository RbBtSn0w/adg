# Authoring an ADG Plugin

A practical guide for **producers**: how to write the `.agents/.plugin.json` DSL,
declare your components, and hand the result to users.

For the normative directory rules see [agents-spec.md](agents-spec.md); the JSON
Schema is [`schemas/adg-plugin.schema.json`](../schemas/adg-plugin.schema.json).

---

## TL;DR

You author **only** `.agents/` artifacts. The runtime projections
(`.claude-plugin/`, `.codex-plugin/`) are **not** something you generate or
commit by default — ADG produces them at install time, into the consumer's tree.

```bash
adg plugins init my-plugin                    # scaffold .agents/.plugin.json + a skill + README
#   ... edit .agents/.plugin.json: DECLARE every component you ship ...
adg plugins validate my-plugin                # check structure + that declared paths exist
git add -A && git commit                       # commit the .agents/ source only
```

Scaffold what you need (the authoring axis is the artifact *kind*, not a runtime):

```bash
adg plugins init my-plugin                     # a plugin      → .agents/.plugin.json   (default)
adg plugins init my-catalog --type marketplace # a catalog     → .agents/.marketplace.json
adg plugins init my-kit      --type all        # catalog + one starter member plugin
```

A finished plugin on disk — **`.agents/` only**:

```
my-plugin/
├── .agents/.plugin.json          # ← source of truth (you edit this)
├── skills/<name>/SKILL.md        # payload
├── commands/  agents/  mcp/      # payload (only if declared!)
└── README.md  LICENSE  CHANGELOG
```

> **The one rule that bites everyone:** packaging and projection are
> **default-deny**. A directory that exists on disk but is **not declared** in
> `.agents/.plugin.json` is neither projected to a runtime nor shipped to users.
> Declare it, or it does not exist.

### Where do `.claude-plugin/` and `.codex-plugin/` come from, then?

They are **runtime projections** — a consumption/publish concern, not an
authoring artifact:

- **On install**, `adg plugins add` generates them into the consumer's
  `.agents/plugins/<name>/` so Claude Code and Codex can discover the plugin. You
  do nothing.
- **Only if you publish to a runtime's own native registry** (e.g. a Claude
  marketplace that reads `.claude-plugin/` straight from your git repo) do you
  run `adg plugins adapt [--target claude|codex|all]` and commit the result.
  Otherwise leave them out of your source repo.

`--target` selects which *runtime* to project for; it is unrelated to the
`init --type` artifact kind above.

---

## The `.agents/.plugin.json` DSL

```jsonc
{
  "schemaVersion": "adg.plugin/v1",            // REQUIRED — exact constant
  "name": "asc",                               // REQUIRED — kebab-case
  "version": "0.1.0",                          // REQUIRED — semver
  "description": "App Store Connect workflows.",// REQUIRED — non-empty

  "author": { "name": "You", "url": "…", "email": "…" },
  "license": "MIT",
  "category": "Developer Tools",
  "interface": { "displayName": "ASC", "icon": "asc.png" },

  // ── Components: path pointers, never inlined content ──
  "skills":   "./skills/",                     // string (root dir) | string[] (explicit paths)
  "commands": "./commands/",                   // string (dir)
  "agents":   "./agents/",                     // string (dir)
  "hooks":    "./hooks/",                      // string (dir)
  "apps":     "./apps/",                       // string (dir)
  "mcp":      "./mcp/.mcp.json",               // string (file)

  "dependencies": [{ "name": "github-cr", "version": "^0.2.0" }],
  "strict": true,                              // default true (see Skills)

  "homepage": "https://github.com/you/asc",
  "changelog": "CHANGELOG.md"
}
```

> Output paths for the runtime projections (`.claude-plugin/plugin.json`,
> `.codex-plugin/plugin.json`) are **ADG-internal conventions** mandated by each
> runtime — they are not configurable from the manifest, so there is no
> `adapters` field to declare.

### Field reference

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `schemaVersion` | `"adg.plugin/v1"` | ✅ | Must equal the constant exactly. |
| `name` | string | ✅ | `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case). |
| `version` | string | ✅ | Semantic version, e.g. `1.2.3`, `1.0.0-rc.1`. |
| `description` | string | ✅ | Non-empty; this is what an agent reads to decide relevance. |
| `author` | `{ name, url?, email? }` | | |
| `license` | string | | SPDX id, e.g. `MIT`. |
| `category` | string | | Free-form, e.g. `Developer Tools`. |
| `interface` | `{ displayName?, icon? }` | | Presentation only. |
| `skills` | string \| string[] | | Root dir (auto-scan) or explicit skill paths. |
| `commands` | string | | Directory of slash-command `.md` files. |
| `agents` | string | | Directory of sub-agent `.md` files. |
| `hooks` | string | | Directory of lifecycle hooks. |
| `apps` | string | | Directory of third-party app integration config. |
| `mcp` | string | | Path to an MCP config file (e.g. `./mcp/.mcp.json`). |
| `dependencies` | `[{ name, version }]` | | Other plugins required; `version` is a semver range. |
| `strict` | boolean | | Default `true`. See **Skills**. |
| `homepage`, `changelog` | string | | |

---

## Skills

A skill is a directory under your skills root with a `SKILL.md` whose front
matter carries a `name` and a `description`:

```markdown
---
name: metadata-sync
description: Pull and push canonical App Store metadata.
---

# metadata-sync
Use when synchronizing App Store listing metadata…
```

Two ways to declare them:

- **Auto-discover (recommended, `strict: true`)** — set `"skills": "./skills/"`.
  Every sub-directory of `skills/` that contains a `SKILL.md` is exposed. The
  projection passes the directory through so each runtime discovers them.
- **Explicit bundle (`strict: false`)** — list paths:
  `"skills": ["./skills/metadata-sync", "./skills/testflight-upload"]`. The
  projection emits an explicit `./skills/<name>` list. Use this when you need a
  fixed, curated set (this is also what `adg plugins import-skills` produces).

---

## Other components

- **commands** — `"./commands/"`, a dir of slash-command markdown files.
- **agents** — `"./agents/"`, a dir of sub-agent definition `.md` files.
- **mcp** — `"./mcp/.mcp.json"`, an MCP server config file (points at a *file*,
  not a dir).
- **hooks**, **apps** — directories, same pattern. For hooks, see **Hooks**
  below — agents differ on the hook config format, so ADG can compile a single
  universal definition into each agent's native file.

Declare only what you ship. Omit a field and that component is absent from both
the runtime projections and the installed package.

---

## Hooks

Agents do not share a hook format. Claude **auto-loads** `hooks/hooks.json` and
expands `${CLAUDE_PLUGIN_ROOT}`; Codex references an explicit
`hooks/hooks-codex.json` from its manifest and expands `${PLUGIN_ROOT}`; and the
matcher vocabularies differ (e.g. `startup|clear|compact` vs
`startup|resume|clear`). Two ways to author:

- **Hand-authored (passthrough)** — ship the native files yourself under
  `hooks/`. ADG carries them as-is: Claude auto-loads `hooks/hooks.json`, and the
  Codex projection references `hooks/hooks-codex.json` (falling back to
  `hooks/hooks.json`). Nothing is rewritten.

- **Universal DSL (recommended, author once)** — add `.agents/hooks.json`
  (`adg.hooks/v1`). Write the canonical command with `${PLUGIN_ROOT}`; capture
  the parts that genuinely differ per agent as `matcherByTarget` /
  `commandByTarget` overrides. On `adapt`/install ADG compiles it to each
  target's native file (`hooks/hooks.json`, `hooks/hooks-codex.json`),
  translating the env token and applying overrides. The compiled files ship but
  do not count toward the content hash. An event ADG doesn't recognize is still
  emitted, with a warning.

  ```json
  {
    "schemaVersion": "adg.hooks/v1",
    "hooks": {
      "SessionStart": [
        {
          "matcher": "startup|clear|compact",
          "matcherByTarget": { "codex": "startup|resume|clear" },
          "actions": [
            {
              "type": "command",
              "command": "\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
              "commandByTarget": { "codex": "\"${PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start-codex" },
              "async": false
            }
          ]
        }
      ]
    }
  }
  ```

  Schema: [adg-hooks.schema.json](../schemas/adg-hooks.schema.json).

---

## Dependencies

```jsonc
"dependencies": [{ "name": "github-cr", "version": "^0.2.0" }]
```

When a user installs your plugin, ADG resolves dependencies in dependency-first
order from the same source/catalog. Names must resolve to a known plugin; an
unresolved name fails the install.

---

## What gets packaged (and what does not)

Installing/cloning a plugin ships a **manifest-driven allowlist**, never the
whole repo:

**Shipped**
- `.agents/.plugin.json` (the manifest);
- the top-level directory of every **declared** component;
- root metadata: `README*`, `LICENSE*`, `CHANGELOG*`, `NOTICE*`;
- the runtime projections `.claude-plugin/`, `.codex-plugin/` — generated at
  install time (or committed by you only if publishing to a native registry).

**Left behind**
- `src/`, `test/`, `docs/`, build output, CI config;
- `.git`, `node_modules`, `.DS_Store`;
- `.env` and any other secret/dev files;
- **any directory you forgot to declare.**

Need to exclude something *inside* a declared component dir? Use git's native
`.gitattributes export-ignore` rather than inventing an ignore file.

---

## Authoring by hand (no CLI)

The CLI is convenience; the format is plain files. To produce a plugin manually:

1. Create the directory and write `.agents/.plugin.json` (above).
2. Add your payload: `skills/<name>/SKILL.md`, `commands/…`, etc. — and declare
   each in the manifest.
3. Run `adg plugins validate <dir>`.

That is the whole authoring artifact. You do **not** generate `.claude-plugin/`
or `.codex-plugin/` — those are produced for you at install time. Only if you
publish to a runtime's native registry do you run `adg plugins adapt <dir>
[--target claude|codex|all]` and commit the result; the output is deterministic,
so never hand-edit it.

---

## Multiple plugins in one repo — the `marketplace.json` DSL

A repo can hold many plugins. Each plugin is self-contained (its own
`.agents/.plugin.json`); the repo declares a **catalog** at the root:

```
my-plugins/
├── .agents/.marketplace.json     # catalog: lists member plugins
├── asc/
│   └── .agents/.plugin.json
└── github-cr/
    └── .agents/.plugin.json
```

### Two roles, one shape

`marketplace.json` appears in two contexts with the **same structure** but
different semantics:

| Role | Location | Written by | Read by |
|------|----------|------------|---------|
| **Source catalog** | `<repo>/.agents/.marketplace.json` (dot-prefixed) | **you (by hand)** | declares the members of a multi-plugin repo |
| **Runtime export** | `<root>/.agents/plugins/marketplace.json` (plain) | ADG `add` (generated) | Codex / Claude discovery |

You author the **source catalog**; ADG generates the runtime export. The schema
is [`marketplace.schema.json`](../schemas/marketplace.schema.json).

### Structure

Keep the authored catalog minimal — a member is just a `name` and a `source`.
Do **not** repeat `version` / `description` / `author` here; those live in each
plugin's `.agents/.plugin.json` and would only drift if duplicated.

```jsonc
{
  "name": "my-plugins",                  // REQUIRED — catalog name (Codex uses it as the marketplace name)
  "description": "My Apple plugins",     // optional
  "owner": { "name": "You" },            // optional

  "plugins": [                           // REQUIRED — members
    { "name": "asc",       "source": "./asc" },                              // local shorthand
    { "name": "github-cr", "source": "./github-cr", "category": "Dev Tools" }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|:--------:|-------|
| `name` | string | ✅ | Catalog id; Codex treats it as the marketplace name. |
| `description` | string | | Catalog summary (replaces the old `interface.displayName`). |
| `owner` | `{ name?, email?, url? }` | | |
| `plugins[].name` | string | ✅ | Must match the member's `.agents/.plugin.json` `name`. |
| `plugins[].source` | string \| object | ✅ | String = local path; object = explicit/remote (below). |
| `plugins[].category` | string | | Free-form. |
| `plugins[].policy` | object | | **Export-only** — ADG writes it for Codex; omit when authoring. |

The reader is tolerant: only `name` (string) and `plugins` (array) are checked,
and **unknown fields are preserved**.

### `source` — string shorthand or object

```jsonc
"source": "./asc"                                                          // local path shorthand
"source": { "source": "local",  "path": "./asc" }                         // explicit local
"source": { "source": "github", "repo": "you/asc", "ref": "v0.1.0", "path": "plugins/asc" }
"source": { "source": "git",    "url": "https://example.com/asc.git", "path": "." }
```

A **local path** (string, or `local.path`) is resolved relative to the
**grandparent** of the catalog file — the directory that contains `.agents/`
(this matches how `codex plugin add` resolves entries; see
`paths.ts:marketplaceSourcePath`). So in `<repo>/.agents/.marketplace.json`,
`"./asc"` points at `<repo>/asc`.

> Remote forms (`github` / `git`) are part of the schema for forward
> compatibility. ADG's generated runtime export always uses the explicit
> `local` object; actually *fetching* a remote catalog member on `add` is a
> separate consumption feature, not yet wired.

Users install one (`adg plugins add <repo> --plugin asc`) or all (`--all`).
Discovery also works **without** a catalog — ADG scans for `.agents/.plugin.json`
files.

---

## Validate & common errors

`adg plugins validate <dir>` checks, in order:

1. `.agents/.plugin.json` exists and is valid JSON;
2. structural validity (required fields, kebab `name`, semver `version`, types);
3. **every declared path exists** (`agents`/`commands`/`apps`/`hooks`/`mcp` dirs
   or files; the `skills` root, or each explicit skill path).

Typical failures:

| Message | Fix |
|---------|-----|
| `schemaVersion must be "adg.plugin/v1"` | Set the constant exactly. |
| `name is required and must be kebab-case` | e.g. `my-plugin`, not `MyPlugin`. |
| `commands points to "./commands/" which does not exist` | Create the dir or drop the field. |
| `skills root "./skills/" does not exist` | Add the dir, or list explicit skill paths. |

---

## Publishing & how users consume it

Push the repo — just the `.agents/` source. A user installs with:

```bash
adg plugins add github.com/you/my-plugin            # or owner/repo, or a local path
adg plugins add github.com/you/my-plugin --global   # ~/.agents/plugins instead of project
```

After install, the user's tree looks like this — ADG generates the projections
here, at consumption time:

```
<project>/.agents/plugins/
├── my-plugin/                       # your declared payload + generated projections
│   ├── .agents/.plugin.json
│   ├── .claude-plugin/plugin.json
│   ├── .codex-plugin/plugin.json
│   └── skills/<name>/SKILL.md
├── .plugin-lock.json                # ADG control plane (provenance, sha256, deps)
├── marketplace.json                 # Codex-facing discovery export
└── .claude-plugin/marketplace.json  # Claude-facing discovery export
```

The runtimes (Claude, Codex) discover the plugin through their respective
`marketplace.json`; you do not need to configure them by hand.

### Legacy note

Plugins authored under the old `.adg-plugin/plugin.json` layout still install
(it is read as a deprecated fallback). Migrate by moving the file to
`.agents/.plugin.json`, then re-running `adapt` and `validate`.
