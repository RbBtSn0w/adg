# Design note: hooks strategy & the unify-vs-adopt principle

**Status:** Accepted, amended 2026-06-29 · **Context:** issue #32, the retired `adg.hooks/v1` DSL

This note records *why* ADG does not own a hooks DSL, and the decision rule that produced that outcome —
so the same wheel isn't reinvented.

## The principle

When a feature spans multiple runtimes, **build a unifying ADG layer only when both hold:**
1. the runtimes **genuinely diverge** (not just cosmetically), **and**
2. there is **no de-facto standard or convergence** to adopt instead.

Otherwise, **adopt the de-facto standard** and keep ADG's role to routing/linting. And within any unifying
layer, draw a hard line:

- **Mechanical translation — ADG may do it.** Deterministic, behavior-preserving rewrites: env-token
  substitution, event-name aliasing, file location/discovery. Same behavior, different spelling.
- **Behavioral synthesis — ADG must not do it.** Which matcher to fire on, which script/command to run.
  That is the author's intent and cannot be invented; it can only be authored.

## Worked example: hooks

Claude's shape (`{hooks:{Event:[{matcher,hooks:[{type,command}]}]}}`) remains the
canonical authoring format. Codex consumes it and accepts `${CLAUDE_PLUGIN_ROOT}`.
Antigravity does not: it requires a root `hooks.json`, named hook definitions,
different lifecycle structure, and camelCase stdin/stdout contracts. The corrected
decision is still **adopt Claude's format**, but add a thin Antigravity target
adapter rather than pretending the native formats are identical.

`superpowers` ships three hook files (`hooks.json`, `hooks-codex.json`, `hooks-cursor.json`) — but that is
**behavioral divergence, not format divergence**: the author chose different matchers and *different scripts*
per agent. A DSL with `commandByTarget`/`matcherByTarget` does not make that "author once" — the author still
specifies both behaviors, just in one file. So the retired DSL had **no sweet spot**:
- homogeneous Claude/Codex plugin → a single native `hooks/hooks.json` runs on both (DSL adds nothing);
- divergent plugin → DSL only relocates the N behaviors into override syntax (DSL adds syntax, not leverage).

### What ADG does instead (router + linter)
- **Same behavior across agents → one file.** Author `hooks/hooks.json` in Claude's format; Claude
  auto-loads it, Codex references the same file, and Antigravity mechanically projects its supported subset.
- **Different behavior per agent → N native files + routing.** Author ships `hooks/hooks-codex.json` (etc.);
  `hooks/hooks-antigravity.json` is the Antigravity escape hatch. ADG routes each native override.
- **Lint** (`checkHookEvents`, `src/hooks.ts`): warn when a hook uses an event a target can't fire (e.g.
  Claude-only `UserPromptExpansion` on Codex or Antigravity) rather than silently dropping behavior.

## Thin Antigravity translation

Antigravity triggered the previously conditional translation layer. It remains
target-local and deterministic; it is not a revived public DSL.

- **File projection** — write Antigravity's required root `hooks.json` without touching canonical source files.
- **Schema projection** — convert `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` into named native definitions.
- **Matcher aliases** — translate only exact built-in tool names and simple alternations; warn and omit unsafe regex rewrites.
- **Protocol bridge** — set canonical plugin-root environment variables and translate the supported stdin/stdout fields.
- **Native escape hatch** — validate and copy `hooks/hooks-antigravity.json` verbatim when a plugin needs target-specific semantics.
- **Failure safety** — validate before atomic replacement, retain the last-known-good projection on invalid input, and fail runtime control outputs that cannot be preserved safely.

**Out of scope:** inventing target-specific commands, guessing complex matcher
semantics, or emulating fields for which Antigravity has no equivalent. These
produce diagnostics and require a native override.

## The manifest is the same *pattern*, not the same *conclusion*

`adg.plugin/v1` (`.agents/.plugin.json`) uses the same canonical-plus-adapters shape, but it stays justified:
1. manifests **genuinely diverge** (per-vendor locations, `skills` encoded as bare-id array vs path array,
   different metadata; superpowers ships 5 manifests) and there is **no adopted manifest standard**
   (`AGENTS.md` standardizes *instructions*, not packaging) — so criteria (1) and (2) both hold; and
2. the manifest is also **ADG's own control plane** — `dependencies`, `strict`, partial-install selection,
   and `.plugin-lock.json` integrity all key off it. Hooks carried no such ADG-internal role.

Its **projection mapping** (skills/commands/agents/hooks/mcpServers → per-agent) shares the hooks risk and would
lose value if vendors converge; its **control-plane core** does not.

## Revisit triggers
- `AGENTS.md` (Linux Foundation / Agentic AI Foundation) expands to cover plugin packaging/manifests.
- Vendors converge on component field encodings (e.g. a single `skills` form).
- A formal cross-vendor **hooks** protocol emerges.

If any fires, shrink the relevant ADG layer toward routing + control-plane only — the move made here for hooks.
