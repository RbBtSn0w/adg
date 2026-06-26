# Design note: hooks strategy & the unify-vs-adopt principle

**Status:** Accepted · **Date:** 2026-06-26 · **Context:** issue #32, the retired `adg.hooks/v1` DSL

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

The three agents' hook **formats have converged on Claude's**: same JSON shape
(`{hooks:{Event:[{matcher,hooks:[{type,command}]}]}}`), Codex consumes it and accepts
`${CLAUDE_PLUGIN_ROOT}`, Antigravity is same-shape. So criterion (2) fails → **adopt Claude's format**, don't
invent a 4th.

`superpowers` ships three hook files (`hooks.json`, `hooks-codex.json`, `hooks-cursor.json`) — but that is
**behavioral divergence, not format divergence**: the author chose different matchers and *different scripts*
per agent. A DSL with `commandByTarget`/`matcherByTarget` does not make that "author once" — the author still
specifies both behaviors, just in one file. So the retired DSL had **no sweet spot**:
- homogeneous plugin → a single native `hooks/hooks.json` already runs on all three (DSL adds nothing);
- divergent plugin → DSL only relocates the N behaviors into override syntax (DSL adds syntax, not leverage).

### What ADG does instead (router + linter)
- **Same behavior across agents → one file.** Author `hooks/hooks.json` in Claude's format; Claude
  auto-loads it, Codex references the same file. This is the real "one file, many agents".
- **Different behavior per agent → N native files + routing.** Author ships `hooks/hooks-codex.json` (etc.);
  ADG's adapter resolvers route each agent to its file. ADG does not synthesize variants.
- **Lint** (`checkHookEvents`, `src/hooks.ts`): warn when a hook uses an event a target can't fire (e.g.
  Claude-only `UserPromptExpansion` on Codex) — read-only, never a transform.

## Conditional plan: thin mechanical translation (build only when a target needs it)

ADG currently supports Claude + Codex hook targets, and **neither needs translation** (Codex accepts Claude's
format + `${CLAUDE_PLUGIN_ROOT}`). So no translation code exists today — deliberately (YAGNI).

**Trigger to implement:** ADG adds a hook target that diverges *mechanically* — most likely **Antigravity**
or **Cursor**. When that happens, add only these deterministic, behavior-preserving steps to the per-agent
hook handling (a small `HookTranslation` per target, near the adapter resolvers — *not* a revived DSL):

- **Env-token substitution** — rewrite `${CLAUDE_PLUGIN_ROOT}` → the target's plugin-root var, for targets
  that don't accept Claude's. (Claude: none; Codex: none — accepts it; Antigravity: TBD.)
- **Event-name aliases** — a per-target rename table for events that are the same concept under a different
  name. Known/suspected (verify against the live agent before shipping):

  | Canonical (Claude) | Antigravity | Codex |
  |---|---|---|
  | `PostToolUse` | `PostInvocation` (reported) | `PostToolUse` |
  | (others) | TBD — verify from the binary/docs | subset, same names |

**Out of scope even then:** matcher values, command/script selection, async semantics — behavioral, author-owned.

## The manifest is the same *pattern*, not the same *conclusion*

`adg.plugin/v1` (`.agents/.plugin.json`) uses the same canonical-plus-adapters shape, but it stays justified:
1. manifests **genuinely diverge** (per-vendor locations, `skills` encoded as bare-id array vs path array,
   different metadata; superpowers ships 5 manifests) and there is **no adopted manifest standard**
   (`AGENTS.md` standardizes *instructions*, not packaging) — so criteria (1) and (2) both hold; and
2. the manifest is also **ADG's own control plane** — `dependencies`, `strict`, partial-install selection,
   and `.plugin-lock.json` integrity all key off it. Hooks carried no such ADG-internal role.

Its **projection mapping** (skills/commands/agents/hooks/mcp → per-agent) shares the hooks risk and would
lose value if vendors converge; its **control-plane core** does not.

## Revisit triggers
- `AGENTS.md` (Linux Foundation / Agentic AI Foundation) expands to cover plugin packaging/manifests.
- Vendors converge on component field encodings (e.g. a single `skills` form).
- A formal cross-vendor **hooks** protocol emerges.

If any fires, shrink the relevant ADG layer toward routing + control-plane only — the move made here for hooks.
