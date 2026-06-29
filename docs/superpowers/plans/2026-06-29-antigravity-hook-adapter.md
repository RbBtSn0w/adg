# Antigravity Hook Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project Claude-format plugin hooks into Antigravity's native root `hooks.json` without introducing an ADG-owned hook DSL.

**Architecture:** Keep `hooks/hooks.json` as the canonical Claude source and retain the existing Codex override routing. Add a target-local Antigravity adapter that prefers `hooks/hooks-antigravity.json`, otherwise translates supported Claude events and runs commands through a generated protocol bridge.

**Tech Stack:** TypeScript, Node.js 22 ESM, `node:test`, JSON plugin manifests.

## Global Constraints

- Do not change the public `adg.plugin/v1` schema.
- Do not rewrite authored `hooks/hooks.json` or `hooks/hooks-codex.json`.
- Antigravity owns generated root `hooks.json`; generated support files live under `.antigravity-plugin/`.
- Unsupported events and handlers warn and are omitted; synchronization continues.
- Do not stage, commit, push, or edit lockfiles/release configuration.

---

### Task 1: Lock Routing and Projection Contracts

**Files:**
- Test: `test/antigravity-hooks.test.ts`
- Test: `test/hooks.test.ts`

**Interfaces:**
- Consumes: `ensureAntigravityRoot(dir, selection?)`, `checkHookEvents(pluginDir, targets)`.
- Produces: failing tests for native override precedence, generated root schema, warnings, cleanup, and canonical-source preservation.

- [ ] Add a Superpowers fixture setup with Claude `SessionStart` hooks.
- [ ] Assert Antigravity emits root `hooks.json` without Claude's top-level `hooks` wrapper.
- [ ] Assert `hooks/hooks-antigravity.json` is copied verbatim when present.
- [ ] Assert unsupported events warn and selected-out hooks remove generated artifacts.
- [ ] Run `node --test test/antigravity-hooks.test.ts test/hooks.test.ts` and confirm RED failures caused by missing Antigravity translation.

### Task 2: Implement the Target Adapter and Runtime Bridge

**Files:**
- Create: `src/adapters/antigravity-hooks.ts`
- Modify: `src/agents/antigravity.ts`
- Modify: `src/commands/adapt.ts`

**Interfaces:**
- Produces: `writeAntigravityHooks(pluginDir: string, manifest: AdgManifest, selection?: PluginSelection): string[]`.
- Produces: deterministic Antigravity named-hook JSON and `.antigravity-plugin/hook-runner.mjs`.

- [ ] Resolve `hooks/hooks-antigravity.json` before canonical `hooks/hooks.json`.
- [ ] Translate `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`; omit unsupported handlers/events with returned warnings.
- [ ] Generate a Node runner that sets plugin-root environment variables, invokes the authored command, and translates supported stdin/stdout fields.
- [ ] Invoke the adapter from both manifest adaptation and Antigravity activation/deactivation paths.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Document the Correct Cross-Agent Contract

**Files:**
- Modify: `docs/authoring.md`
- Modify: `docs/hooks-strategy.md`
- Modify: `src/hooks.ts`

**Interfaces:**
- Consumes: the implemented resolver precedence and mapping limitations.
- Produces: accurate author guidance and lint diagnostics for Antigravity.

- [ ] Replace the incorrect same-shape Antigravity claim with Claude canonical plus target mapping.
- [ ] Document native target overrides and root `hooks.json` ownership.
- [ ] Extend hook linting to Antigravity and describe warning-only behavior.

### Task 4: Verify the Complete Change

**Files:**
- Test: all affected test files and repository checks.

**Interfaces:**
- Produces: build, typecheck, test, and diff evidence.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Inspect `git diff --check`, `git status --short`, and the final diff for generated-file ownership or unrelated changes.
