import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCodexHooksFile } from "./adapters/codex.ts";

/**
 * Hooks linting over the de-facto standard format.
 *
 * A plugin ships `hooks/hooks.json` in Claude's native shape (using
 * `${CLAUDE_PLUGIN_ROOT}`). Claude auto-loads it and Codex can consume it
 * verbatim; an author can ship `hooks/hooks-codex.json` to override Codex.
 * Antigravity diverges in file location, schema, and runtime I/O, so its adapter
 * projects supported canonical events into a root `hooks.json`. A native
 * `hooks/hooks-antigravity.json` bypasses that translation.
 *
 * `checkHookEvents` surfaces events that a selected target cannot fire or map,
 * rather than letting them become silent no-ops at adapt/install time.
 */

export type HookTarget = "claude" | "codex" | "antigravity";

/**
 * Canonical Claude events each target can consume or mechanically map, from the
 * official runtime docs. This table drives diagnostics; target adapters remain
 * responsible for projection.
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
  antigravity: new Set(["SessionStart", "PreToolUse", "PostToolUse", "Stop"]),
};

/** The hooks file `target` will actually load (plugin-relative), or undefined. */
function hooksFileForTarget(pluginDir: string, target: HookTarget): string | undefined {
  // Codex references a file from its manifest (its own variant if shipped, else
  // the shared file) — reuse the adapter's resolution so the lint matches reality.
  if (target === "codex") return resolveCodexHooksFile(pluginDir, "./hooks/");
  if (target === "antigravity") {
    const native = join(pluginDir, "hooks", "hooks-antigravity.json");
    if (existsSync(native)) return undefined; // Native DSL does not need Claude-event linting.
    return existsSync(join(pluginDir, "hooks", "hooks.json")) ? "hooks/hooks.json" : undefined;
  }
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
 * Warn when a canonical hook event cannot run on a target. This is read-only;
 * Antigravity's actual translation lives in its target adapter.
 */
export function checkHookEvents(pluginDir: string, targets: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const t of targets) {
    if (t !== "claude" && t !== "codex" && t !== "antigravity") continue;
    const rel = hooksFileForTarget(pluginDir, t);
    if (!rel) continue;
    for (const event of hookEventsOf(join(pluginDir, rel))) {
      if (!SUPPORTED_EVENTS[t].has(event)) {
        warnings.push(
          t === "antigravity"
            ? `hook event "${event}" is not a supported antigravity hook mapping — antigravity will not fire it`
            : `hook event "${event}" is not a known ${t} hook event — ${t} will not fire it`,
        );
      }
    }
  }
  return warnings;
}
