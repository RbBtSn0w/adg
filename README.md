# Agent Directory Group (ADG)

`adg` is one umbrella CLI with **two domains**, each aligned to an existing
ecosystem so there is little new to learn:

| Domain | Command | Aligns to |
|--------|---------|-----------|
| **plugins** | `adg plugins <verb>` | the Codex plugin flow (`~/.agents/plugins/marketplace.json`) |
| **skills** | `adg skills <verb>` | [vercel-labs/skills](https://github.com/vercel-labs/skills) — a **vendored fork** (see [vendor/skills](vendor/skills/PROVENANCE.md)) |

For plugins, one universal manifest — `.agents/.plugin.json` — is the source
of truth. Runtime-specific manifests (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`) are *generated* from it, so a plugin is authored
once and adapted to each runtime.

**Control plane vs export.** ADG's own management lives in the lock
(`.plugin-lock.json`: provenance, `sha256` integrity, dependencies) — that is the
only file ADG treats as authoritative. `marketplace.json` is a thin
**runtime-facing export** kept in the de-facto shape Codex consumes; ADG never
manages plugins through it.

See [docs/authoring.md](docs/authoring.md) to author a plugin, and
[docs/agents-spec.md](docs/agents-spec.md) for the `.agents/` directory spec.

## Why

- **Skill explosion** — hundreds of skills become unmanageable; ADG groups them
  into versioned, discoverable plugins.
- **Runtime fragmentation** — Claude and Codex use different plugin layouts;
  ADG generates each from a single source.
- **Reproducibility** — `.plugin-lock.json` records source, version and a content
  hash for every installed plugin.

---

# Install and quick start

Install the CLI once, then run `adg` from anywhere:

```bash
npm install -g @rbbtsn0w/adg          # stable channel
npm install -g @rbbtsn0w/adg@beta     # pre-release channel
# or run ad-hoc, no install:
npx @rbbtsn0w/adg --help
```

Typical end-user flow — pull a marketplace into your global store, then load it
into the runtimes you use:

```bash
# 1) collect plugins into the global store (~/.agents/plugins)
adg plugins add anthropics/knowledge-work-plugins --ref main --global
#    large monorepo? fetch only what you need:
adg plugins add anthropics/knowledge-work-plugins --ref main --sparse engineering --global

# 2) load into the runtimes you use
adg plugins link --target codex  --global     # Codex discovers ~/.agents/plugins natively
adg plugins link --target claude --global     # Claude loads via ~/.claude/skills symlinks

# 3) keep it current
adg plugins update --global
adg plugins list --global
```

`adg` is the only command you invoke — no Node build step beyond the global
install. To hack on the CLI itself, see [Developing from source](#developing-from-source).

---

# Works with existing ecosystems

ADG is **not** a new plugin format you have to migrate to. Any repo that already
ships `.claude-plugin/` or `.codex-plugin/` manifests is ingested as-is: on the
way in, `add` discovers each native manifest and **reverse-adapts** it into a
canonical `.agents/.plugin.json` (the inverse of `adapt`), then ADG manages and
re-projects it like any first-party plugin. No fork, no edits upstream.

The two examples below are real, popular repositories — neither is ADG-native.

### Example 1 — `anthropics/knowledge-work-plugins` (a category monorepo)

A marketplace monorepo where each top-level category (`engineering/`,
`marketing/`, `legal/`, …) is its own plugin with a `.claude-plugin/plugin.json`
and a `skills/` tree. Pull the whole thing, or sparse-checkout just the
categories you want:

```bash
# whole marketplace into the global store
adg plugins add anthropics/knowledge-work-plugins --ref main --global

# or fetch only one category from the large monorepo
adg plugins add anthropics/knowledge-work-plugins --ref main --sparse engineering --global

# each category's .claude-plugin manifest is reverse-adapted on import,
# then projected back onto the runtimes you use
adg plugins link --target claude --global   # → ~/.claude/skills/<plugin>:<skill>
adg plugins link --target codex  --global   # native, zero-copy
adg plugins list --global
```

### Example 2 — `obra/superpowers` (a single multi-runtime plugin)

A single skills plugin that already ships `.claude-plugin/`, `.codex-plugin/` and
a `skills/` library. Because the native manifests are already present, ADG simply
adopts it — discovery picks up the existing manifest, records provenance and a
content hash in the lock, and from then on it updates like any ADG plugin:

```bash
adg plugins add obra/superpowers --ref main --global

# now under management — same lifecycle as a first-party plugin
adg plugins list --global
adg plugins update --global
adg plugins link --target claude --global
```

> Both repos are pulled by `owner/repo` shorthand over a shallow clone (sparse
> checkout when `--sparse` is given). Provenance — `{type:"github",repo,ref,path}`
> — plus a `sha256` integrity hash land in `.plugin-lock.json`, so the install is
> reproducible regardless of which ecosystem the plugin originally came from. See
> [Importing existing inventory (via `add`)](#importing-existing-inventory-via-add)
> for the discovery and reverse-adaptation details.

---

# Concepts (common)

These apply the same whether you run a released build or the source tree.

## Layout

```
plugins/                       reference plugins + a generated marketplace
├── .plugin-lock.json          lock file (generated)
├── marketplace.json           marketplace listing (generated)
├── asc/                       strict plugin (explicit skills)
└── github-cr/                 non-strict plugin (auto-scanned skills)

schemas/                       JSON Schemas for the three ADG file formats
src/                           CLI library (manifest, hash, adapters, lock, ...)
bin/adg.ts                     CLI entry point
test/                          node:test suite
```

A single plugin directory:

```
asc/
├── .agents/.plugin.json       universal manifest (source of truth)
├── .claude-plugin/plugin.json generated by `adg plugins adapt`
├── .codex-plugin/plugin.json  generated by `adg plugins adapt`
├── skills/<kebab-name>/SKILL.md
├── agents/  commands/  hooks/  mcp/  apps/
└── README.md
```

## File formats

| File | Schema | Role |
|------|--------|------|
| `.agents/.plugin.json` | [adg-plugin.schema.json](schemas/adg-plugin.schema.json) (`adg.plugin/v1`) | Universal manifest — source of truth |
| `.plugin-lock.json` | [plugin-lock.schema.json](schemas/plugin-lock.schema.json) (`version: 2`) | **Control plane** — ADG's authoritative state |
| `marketplace.json` | [marketplace.schema.json](schemas/marketplace.schema.json) | **Export** — de-facto catalog for Codex |

The split is deliberate:

- **Lock (control plane, ADG-owned).** Carries provenance (`origin`, a
  discriminated `source` union: `{type:"local",path}` / `{type:"github",repo,ref?,path?}`
  / `{type:"git",url,ref?,path?}`), `sha256` content integrity, resolved
  `version`, and dependencies. Every control operation — `list`, `update`,
  `link`, collision detection, dependency resolution — keys off the lock.
  Installing a same-named plugin from a *different* `origin` is rejected as a
  collision.
- **Marketplace (export, runtime-owned shape).** Written in the de-facto shape
  Codex consumes (`{ name, source: { source, path }, policy, category }`, no
  ADG-specific schema). ADG never reads it as authority — it is regenerated from
  the plugin directories. Integrity/version/provenance deliberately do **not**
  appear here; they live in the lock.

`strict: true` exposes only the manifest's declared skills; `strict: false`
auto-scans the `skills/` directory (Claude "skill-bundle" form). The Codex
manifest always emits an explicit `skills` array.

---

# Commands (common)

The command surface is identical in both modes — **only the launcher differs**:

| Mode | Launcher | Setup |
|------|----------|-------|
| Released build | `adg …` | install the package (see [Install and quick start](#install-and-quick-start)) |
| From source (debug) | `node bin/adg.ts …` | clone + `npm install` (see [Developing from source](#developing-from-source)) |

The examples below use the released `adg` launcher. **When running from source,
replace `adg` with `node bin/adg.ts`** — everything else is the same.

```bash
# scaffold a new plugin under ./plugins/<name>
adg plugins init my-plugin

# generate runtime manifests (claude | codex | all)
adg plugins adapt plugins/my-plugin --target all

# validate manifest + referenced paths
adg plugins validate plugins/my-plugin

# add from a local dir: copy, adapt, hash, update lock + marketplace
adg plugins add plugins/my-plugin --project        # <repo>/.agents/plugins
adg plugins add plugins/my-plugin --global         # ~/.agents/plugins
adg plugins add plugins/asc --dir plugins          # explicit target dir

# add from GitHub (shorthand, @ref, or full URL); --path selects a monorepo subdir
adg plugins add owner/repo --dir plugins
adg plugins add owner/repo@v0.1.0 --path plugins/asc --dir plugins
adg plugins add https://github.com/owner/repo.git --ref main --dir plugins
adg plugins add plugins/asc --dir plugins --no-deps   # skip transitive deps

# add existing native plugins — Codex/Claude manifests are reverse-adapted into
# .agents/.plugin.json automatically during discovery (no separate `import` verb)
adg plugins add owner/repo --ref main --sparse .agents/plugins --sparse plugins --global
adg plugins add ./some/local/repo --dir plugins
adg plugins import-skills ~/.agents/skills --as asc --prefix asc- --dir plugins

# project installed plugins into a runtime's discovery path
adg plugins link --target codex --global   # regenerate .codex-plugin in place
adg plugins link --target claude --global  # symlink into ~/.claude/skills/

# maintenance
adg plugins update --dir plugins           # refresh lock hashes/versions from disk
adg plugins list --dir plugins             # list locked plugins
adg plugins migrate --dir plugins          # move flat installs into per-marketplace dirs
```

#### On-disk layout

Plugins are grouped on disk by the source they came from. Remote installs nest
under a per-marketplace bucket; local installs stay flat:

```
.agents/plugins/
├── .plugin-lock.json
├── marketplace.json
├── my-local-plugin/              ← local: flat
└── owner__repo/                  ← remote: owner/repo, "/" flattened to "__"
    ├── asc/
    └── github-cr/
```

The plugin **name stays the unique key** across the lock, `marketplace.json`, and
the Claude symlink bridge — nesting is organizational only, so two sources still
can't both install a plugin of the same name. `marketplace.json`'s `source.path`
tracks the real on-disk path (e.g. `./owner__repo/asc`), keeping the Codex export
accurate. Run `adg plugins migrate` once to lift an older flat store into this
layout.

### Skills domain

`adg skills <verb>` (add/use/remove/list/find/update/init) is a **vendored fork**
of [vercel-labs/skills](https://github.com/vercel-labs/skills) under
[vendor/skills/](vendor/skills/) — `adg skills` forwards all args to it. Run
`adg skills --help` for its full usage.

> **License.** Upstream `skills` is **MIT** (declared in its README and
> `package.json`). The vendored copy retains a reconstructed
> [LICENSE](vendor/skills/LICENSE) (MIT + attribution) and the upstream
> third-party notices; see [vendor/skills/PROVENANCE.md](vendor/skills/PROVENANCE.md).
> GitHub's API shows `license: null` only because upstream ships no standalone
> LICENSE file. The 6 runtime dependencies in `package.json` exist solely for
> this vendored CLI; ADG's own plugins code remains dependency-free.

### Install scopes

- `--project` (default) → `<repo>/.agents/plugins`
- `--global` → `~/.agents/plugins`, honoring `ADG_PLUGINS_HOME`, then
  `XDG_STATE_HOME/.agents/plugins`
- `--dir <path>` → an explicit plugins directory

**Safety:** ADG only ever reads and writes the `plugins/` subtree of a scope.
The sibling `~/.agents/AGENTS.md` and `~/.agents/skills/` are never touched.

### Sources & dependencies

`add` accepts a local path or a GitHub source (`owner/repo`,
`owner/repo@ref`, or a `github.com` URL). GitHub sources are shallow-cloned to a
temp dir (with cone-mode sparse checkout when `--sparse` is given); the lock
records the `origin` (`{type:"github",repo,ref,path}`) for reproducibility.

Plugin `dependencies` are resolved against sibling plugins in the same source
tree: install order is a topological sort with semver (`^`, `~`, exact, `*`,
comparators) checks; cycles / missing deps / version conflicts fail fast. Pass
`--no-deps` to install only the requested plugin.

### Importing existing inventory (via `add`)

`add` also brings non-ADG plugins under management. During discovery it scans the
source for `.agents/.plugin.json` (or legacy `.adg-plugin`), `.codex-plugin` or
`.claude-plugin` manifests; native manifests are **reverse-adapted** into a
canonical `.agents/.plugin.json` (the inverse of `adapt`) and installed
normally. `import-skills` wraps a flat
`<name>/SKILL.md` directory (e.g. a pile of global skills) into a single plugin,
optionally filtered by `--prefix`.

### Runtime mapping (`link`)

A single `.agents/plugins/` source of truth is projected onto each runtime's
private discovery path:

| | Codex (OpenAI) | Claude (Anthropic) |
|---|---|---|
| plugin manifest | `.codex-plugin/plugin.json` (generated) | `.claude-plugin/plugin.json` (generated) |
| marketplace root | `~/.agents/plugins/` — **native, zero-copy** | `~/.claude/skills/<name>/` — **symlink bridge** |
| skill name | scanned | namespaced `/<plugin>:<skill>` |

- `link --target codex` only (re)generates `.codex-plugin/plugin.json` —
  `.agents/plugins/` is already Codex's marketplace root.
- `link --target claude [--global]` (re)generates `.claude-plugin/plugin.json`
  and symlinks each plugin into Claude's skills-dir (`~/.claude/skills/` with
  `--global`, else `<cwd>/.claude/skills/`) so it auto-loads as
  `<name>@skills-dir`. Symlinks never overwrite a real directory — only a stale
  symlink is replaced. This writes under Claude's own `~/.claude/`; the
  never-touched `~/.agents/skills/` and `~/.agents/AGENTS.md` are unaffected.

---

# Developing from source

For working on the CLI itself, or testing a plugin before release. The CLI runs
directly on **Node ≥ 22.6** via native TypeScript type-stripping — **no build
step**.

```bash
git clone <this-repo> && cd adg
npm install                   # dev-only: typescript + @types/node

# run any command straight from source (replace `adg` with this prefix)
node bin/adg.ts --help
node bin/adg.ts plugins validate plugins/asc

# quality gates
npm test                      # node --test  (76 cases)
npm run typecheck             # tsc --noEmit
```

Debugging tips:

- **Use a scratch target, not your real environment.** Prefer `--dir /tmp/store`
  over `--global` while iterating, so you never write to `~/.agents/plugins` or
  `~/.claude/skills` by accident:
  ```bash
  node bin/adg.ts plugins add ./some/repo --dir /tmp/adg-store
  node bin/adg.ts plugins list --dir /tmp/adg-store
  ```
- **Refreshing reference artifacts:** the `plugins/.plugin-lock.json` and
  `plugins/marketplace.json` are generated. Re-sync the lock hashes from disk with
  `node bin/adg.ts plugins update --dir plugins`.
- **Inspect generated manifests** under each plugin's `.claude-plugin/` and
  `.codex-plugin/` to confirm adaptation output.
- GitHub clone/sparse logic is injectable (`gitRunner`) and covered offline by
  the test suite; live network clones are exercised by `import owner/repo`.

## License

MIT
