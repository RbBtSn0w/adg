import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "./fsutil.ts";

/**
 * ADG universal hooks DSL (`adg.hooks/v1`) and its per-agent compiler.
 *
 * Agents do not share a hook format: Claude auto-loads `hooks/hooks.json` and
 * uses `${CLAUDE_PLUGIN_ROOT}`; Codex references an explicit file and uses
 * `${PLUGIN_ROOT}`; and real plugins (e.g. superpowers) genuinely diverge per
 * agent — different matcher vocabularies (`clear|compact` vs `resume|clear`) and
 * even different scripts. So the DSL is authored once with a canonical
 * `${PLUGIN_ROOT}` token, and carries *optional* per-target overrides for the
 * parts that truly differ. The compiler resolves overrides, translates the env
 * token, and warns (never silently drops) on events a target may not support.
 *
 * The universal source lives at `.agents/hooks.json` and is opt-in: plugins that
 * still ship hand-authored `hooks/*.json` keep working unchanged.
 */

export const ADG_HOOKS_SCHEMA_VERSION = "adg.hooks/v1";

/** Canonical location of the universal hooks document inside a plugin. */
export const ADG_HOOKS_PATH = ".agents/hooks.json";

export type HookTarget = "claude" | "codex";

/**
 * Where each target's compiled hook file lands (plugin-relative, POSIX). Claude
 * auto-loads `hooks/hooks.json`; Codex references `hooks/hooks-codex.json` from
 * its manifest. These are generated outputs — shipped, but excluded from the
 * content hash (see `GENERATED_HOOK_FILES`).
 */
export const HOOK_OUTPUT: Record<HookTarget, string> = {
  claude: "hooks/hooks.json",
  codex: "hooks/hooks-codex.json",
};

/** The set of generated hook files, treated like adapter projections (not hashed). */
export const GENERATED_HOOK_FILES: ReadonlySet<string> = new Set(Object.values(HOOK_OUTPUT));

/** A single action fired by a hook entry. */
export interface AdgHookAction {
  /** Only "command" today; kept explicit so the native shape round-trips. */
  type: "command";
  /** Canonical command line; references the plugin root as `${PLUGIN_ROOT}`. */
  command: string;
  async?: boolean;
  /** Per-target command override for genuine behavioral divergence. */
  commandByTarget?: Partial<Record<HookTarget, string>>;
}

/** One matcher+actions group under an event. */
export interface AdgHookEntry {
  matcher?: string;
  /** Per-target matcher override (agents use different matcher vocabularies). */
  matcherByTarget?: Partial<Record<HookTarget, string>>;
  actions: AdgHookAction[];
}

/** The universal hooks document (`.agents/hooks.json`). */
export interface AdgHooks {
  schemaVersion: typeof ADG_HOOKS_SCHEMA_VERSION;
  /** Event name (e.g. "SessionStart") → its matcher/action groups. */
  hooks: Record<string, AdgHookEntry[]>;
}

/** The native (Claude/Codex) hooks.json shape the compiler emits. */
export interface NativeHookAction {
  type: string;
  command: string;
  async?: boolean;
}
export interface NativeHookEntry {
  matcher?: string;
  hooks: NativeHookAction[];
}
export interface NativeHooks {
  hooks: Record<string, NativeHookEntry[]>;
}

/** The plugin-root env variable each target expands. */
const ENV_TOKEN: Record<HookTarget, string> = {
  claude: "CLAUDE_PLUGIN_ROOT",
  codex: "PLUGIN_ROOT",
};

/**
 * Documented hook events. Used only to *warn* on an unfamiliar event — the
 * compiler still emits it, so an event this list hasn't caught up with is never
 * silently dropped. (Codex's vocabulary is not fully published; this is Claude's
 * set, treated as the canonical baseline.)
 */
const KNOWN_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

/** Replace the canonical `${PLUGIN_ROOT}` token with the target's env variable. */
function translateEnv(value: string, target: HookTarget): string {
  // Function replacement so `$` in the substitution is never treated specially.
  return value.replaceAll("${PLUGIN_ROOT}", () => `\${${ENV_TOKEN[target]}}`);
}

/**
 * Compile the universal hooks document into one target's native `hooks.json`
 * object, resolving per-target overrides and translating the env token. Returns
 * the native object plus any non-fatal warnings (unknown events).
 */
export function compileHooks(src: AdgHooks, target: HookTarget): { hooks: NativeHooks; warnings: string[] } {
  const warnings: string[] = [];
  const out: NativeHooks = { hooks: {} };

  for (const [event, entries] of Object.entries(src.hooks)) {
    if (!KNOWN_EVENTS.has(event)) {
      warnings.push(`unknown hook event "${event}" — emitted for ${target} but it may not fire`);
    }
    out.hooks[event] = entries.map((entry) => {
      const matcher = entry.matcherByTarget?.[target] ?? entry.matcher;
      const actions: NativeHookAction[] = entry.actions.map((a) => {
        const command = translateEnv(a.commandByTarget?.[target] ?? a.command, target);
        return { type: a.type, command, ...(a.async !== undefined ? { async: a.async } : {}) };
      });
      return { ...(matcher !== undefined ? { matcher } : {}), hooks: actions };
    });
  }

  return { hooks: out, warnings };
}

/** Rewrite any agent's plugin-root token back to the canonical `${PLUGIN_ROOT}`. */
function canonicalizeEnv(value: string): string {
  return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", () => "${PLUGIN_ROOT}");
}

/**
 * Lift native hook files into one universal document — the inverse of
 * `compileHooks`. Where the targets agree, a single canonical value is emitted;
 * where they genuinely diverge (matcher or command), the difference is captured
 * as a per-target override, so recompiling reproduces each native file. Targets
 * are aligned positionally per event; a shape mismatch is reported (not dropped)
 * and the primary (Claude when present) is used as the structural base.
 */
export function liftHooks(natives: Partial<Record<HookTarget, NativeHooks>>): { hooks: AdgHooks; warnings: string[] } {
  const warnings: string[] = [];
  const present = (Object.keys(natives) as HookTarget[]).filter((t) => natives[t]);
  const events = new Set(present.flatMap((t) => Object.keys(natives[t]!.hooks)));
  const out: AdgHooks = { schemaVersion: ADG_HOOKS_SCHEMA_VERSION, hooks: {} };

  for (const event of events) {
    const primary: HookTarget = natives.claude?.hooks[event] ? "claude" : "codex";
    const other = present.find((t) => t !== primary && natives[t]!.hooks[event]);
    const baseEntries = natives[primary]!.hooks[event]!;
    const otherEntries = other ? natives[other]!.hooks[event] : undefined;
    if (other && otherEntries && otherEntries.length !== baseEntries.length) {
      warnings.push(`hook event "${event}" has a different shape per target; lifted from ${primary}`);
    }

    out.hooks[event] = baseEntries.map((entry, i) => {
      const oEntry = otherEntries?.[i];
      const adg: AdgHookEntry = { actions: [] };
      if (entry.matcher !== undefined) adg.matcher = entry.matcher;
      if (other && oEntry && oEntry.matcher !== undefined && oEntry.matcher !== entry.matcher) {
        adg.matcherByTarget = { [other]: oEntry.matcher };
      }
      adg.actions = entry.hooks.map((act, j) => {
        const a: AdgHookAction = { type: "command" as const, command: canonicalizeEnv(act.command) };
        if (act.async !== undefined) a.async = act.async;
        const oAct = oEntry?.hooks[j];
        if (other && oAct) {
          const oCmd = canonicalizeEnv(oAct.command);
          if (oCmd !== a.command) a.commandByTarget = { [other]: oCmd };
        }
        return a;
      });
      return adg;
    });
  }

  return { hooks: out, warnings };
}

/** Outcome of lifting a plugin's native hook files into the universal DSL. */
export interface LiftHooksResult {
  /** The written DSL file, plugin-relative (`.agents/hooks.json`). */
  file: string;
  /** Which native targets were found and lifted. */
  sources: HookTarget[];
  warnings: string[];
}

/**
 * Read a plugin's native hook files (`hooks/hooks.json`, `hooks/hooks-codex.json`)
 * and lift them into one universal `.agents/hooks.json`, the inverse of the
 * compile step. Returns undefined when the plugin ships no native hooks (nothing
 * to convert). The native files are left in place — a later adapt regenerates
 * them from the DSL. Throws on a malformed native file rather than guessing.
 */
export function liftHooksFromDisk(pluginDir: string): LiftHooksResult | undefined {
  const natives: Partial<Record<HookTarget, NativeHooks>> = {};
  const sources: HookTarget[] = [];
  for (const target of Object.keys(HOOK_OUTPUT) as HookTarget[]) {
    const file = join(pluginDir, HOOK_OUTPUT[target]);
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as NativeHooks).hooks !== "object") {
      throw new Error(`${HOOK_OUTPUT[target]} is not a valid hooks file (missing \`hooks\` map)`);
    }
    natives[target] = parsed as NativeHooks;
    sources.push(target);
  }
  if (sources.length === 0) return undefined;

  const { hooks, warnings } = liftHooks(natives);
  writeJson(join(pluginDir, ADG_HOOKS_PATH), hooks);
  return { file: ADG_HOOKS_PATH, sources, warnings };
}

/** One compiled hook file written to disk, with any warnings from compilation. */
export interface CompiledHookFile {
  /** Plugin-relative output path (e.g. "hooks/hooks.json"). */
  file: string;
  warnings: string[];
}

/**
 * If `pluginDir` opts into the DSL (has `.agents/hooks.json`), compile it to each
 * requested target's native hook file and write them under `hooks/`. A no-op
 * (returns []) when the DSL source is absent — plugins shipping hand-authored
 * `hooks/*.json` are left untouched. Only claude/codex are compiled today;
 * targets without a `HOOK_OUTPUT` mapping (e.g. antigravity) are skipped.
 */
export function compileHooksToDisk(pluginDir: string, targets: readonly string[]): CompiledHookFile[] {
  const src = join(pluginDir, ADG_HOOKS_PATH);
  if (!existsSync(src)) return [];
  const doc = parseAdgHooks(JSON.parse(readFileSync(src, "utf8")));

  const written: CompiledHookFile[] = [];
  for (const target of targets) {
    if (!(target in HOOK_OUTPUT)) continue;
    const t = target as HookTarget;
    const { hooks, warnings } = compileHooks(doc, t);
    const rel = HOOK_OUTPUT[t];
    writeJson(join(pluginDir, rel), hooks);
    written.push({ file: rel, warnings });
  }
  return written;
}

/**
 * Parse and shallowly validate a raw `.agents/hooks.json` payload. Throws with a
 * pointed message rather than letting a malformed document surface as a deep
 * runtime error during compilation.
 */
export function parseAdgHooks(raw: unknown): AdgHooks {
  if (typeof raw !== "object" || raw === null) throw new Error("hooks document must be a JSON object");
  const d = raw as Record<string, unknown>;
  if (d.schemaVersion !== ADG_HOOKS_SCHEMA_VERSION) {
    throw new Error(`hooks document must declare schemaVersion "${ADG_HOOKS_SCHEMA_VERSION}"`);
  }
  if (typeof d.hooks !== "object" || d.hooks === null) throw new Error("hooks document missing `hooks` map");
  for (const [event, entries] of Object.entries(d.hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) throw new Error(`hook event "${event}" must be an array of entries`);
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      if (!Array.isArray(e.actions)) throw new Error(`hook event "${event}" entry missing \`actions\` array`);
      for (const action of e.actions as unknown[]) {
        const a = action as Record<string, unknown>;
        if (a.type !== "command") throw new Error(`hook action in "${event}" must have type "command"`);
        if (typeof a.command !== "string") throw new Error(`hook action in "${event}" missing string \`command\``);
      }
    }
  }
  return raw as AdgHooks;
}
