import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHooksFile } from "./adapters/codex.ts";

/**
 * Hooks linting over the de-facto standard format.
 *
 * Agent hook formats have converged on Claude's: a plugin ships a single
 * `hooks/hooks.json` in Claude's native shape (using `${CLAUDE_PLUGIN_ROOT}`),
 * which Claude auto-loads and Codex consumes verbatim (it accepts the same
 * structure and `${CLAUDE_PLUGIN_ROOT}`). ADG does not transform hooks — the
 * adapters only route each agent's manifest to the right file, and an author can
 * ship a `hooks/hooks-codex.json` to override Codex.
 *
 * The one cross-agent gap ADG surfaces is *event support*: an event exists in
 * Claude but not Codex (e.g. `UserPromptExpansion`), so a hook on it silently
 * never fires there. `checkHookEvents` warns about that at adapt/install time.
 */

export type HookTarget = "claude" | "codex";

/**
 * Hook events each target fires, from the official docs (Claude
 * code.claude.com/docs/en/hooks, Codex developers.openai.com/codex/hooks). Used
 * only to warn — never to drop — so an event these lists haven't caught up with
 * is reported as unknown rather than hidden. Codex is a subset of Claude's set.
 */
const SUPPORTED_EVENTS: Record<HookTarget, ReadonlySet<string>> = {
  claude: new Set([
    "SessionStart", "Setup", "SessionEnd",
    "UserPromptSubmit", "UserPromptExpansion", "Stop", "StopFailure",
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
    "PermissionRequest", "PermissionDenied",
    "SubagentStart", "SubagentStop", "TeammateIdle",
    "TaskCreated", "TaskCompleted",
    "InstructionsLoaded", "ConfigChange", "FileChanged", "CwdChanged",
    "WorktreeCreate", "WorktreeRemove",
    "PreCompact", "PostCompact",
    "Elicitation", "ElicitationResult", "Notification", "MessageDisplay",
  ]),
  codex: new Set([
    "SessionStart", "SubagentStart", "PreToolUse", "PermissionRequest",
    "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit",
    "SubagentStop", "Stop",
  ]),
};

/** The hooks file `target` will actually load (plugin-relative), or undefined. */
function hooksFileForTarget(pluginDir: string, target: HookTarget): string | undefined {
  // Codex references a file from its manifest (its own variant if shipped, else
  // the shared file) — reuse the adapter's resolution so the lint matches reality.
  if (target === "codex") return resolveCodexHooksFile(pluginDir, "./hooks/");
  // Claude auto-loads only the standard hooks/hooks.json.
  return existsSync(join(pluginDir, "hooks", "hooks.json")) ? "hooks/hooks.json" : undefined;
}

/** Event names declared in a Claude-format hooks file; tolerant (the agents validate). */
function hookEventsOf(file: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { hooks?: unknown };
    const map = doc?.hooks;
    return typeof map === "object" && map !== null ? Object.keys(map as Record<string, unknown>) : [];
  } catch {
    return [];
  }
}

/**
 * Warn when a plugin's hooks file declares an event the target agent can't fire,
 * so a no-op hook (e.g. a Claude-only `UserPromptExpansion` projected to Codex)
 * surfaces instead of silently doing nothing. Pure read-only lint — no transform.
 */
export function checkHookEvents(pluginDir: string, targets: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const t of targets) {
    if (t !== "claude" && t !== "codex") continue;
    const rel = hooksFileForTarget(pluginDir, t);
    if (!rel) continue;
    for (const event of hookEventsOf(join(pluginDir, rel))) {
      if (!SUPPORTED_EVENTS[t].has(event)) {
        warnings.push(`hook event "${event}" is not a known ${t} hook event — ${t} will not fire it`);
      }
    }
  }
  return warnings;
}
