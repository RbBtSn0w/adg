import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Antigravity tool name -> Claude tool name, the inverse of TOOL_ALIASES in
 * antigravity-hooks.ts. Kept as a literal (not derived at runtime — this file
 * runs standalone, as a child process, with no import access to the TS
 * module) but `test/antigravity-hook-runner.test.ts` asserts it stays the
 * exact inverse of TOOL_ALIASES so the two tables can't silently drift.
 */
export function claudeToolName(name) {
  return ({
    run_command: "Bash",
    view_file: "Read",
    write_to_file: "Write",
    replace_file_content: "Edit",
    multi_replace_file_content: "Edit",
    find_by_name: "Glob",
    grep_search: "Grep",
    search_web: "WebSearch",
    read_url_content: "WebFetch",
    invoke_subagent: "Agent",
    ask_question: "AskUserQuestion",
  })[name] ?? name;
}

function main() {
  const [event, encodedCommand] = process.argv.slice(2);
  const rawInput = readFileSync(0, "utf8");
  let input;
  try {
    input = rawInput.trim() ? JSON.parse(rawInput) : {};
  } catch (error) {
    fail("invalid Antigravity hook input", error);
  }

  if (event === "SessionStart" && input.invocationNum !== 0) {
    emit({});
    process.exit(0);
  }

  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const command = Buffer.from(encodedCommand, "base64url").toString("utf8")
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${PLUGIN_ROOT}", pluginRoot);
  const childInput = claudeInput(event, input, pluginRoot);
  const child = spawnSync(command, {
    cwd: pluginRoot,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify(childInput),
    encoding: "utf8",
    shell: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) fail("failed to launch hook command", child.error);
  if (child.status !== 0) process.exit(child.status ?? 1);

  const output = parseOutput(event, child.stdout);
  emit(antigravityOutput(event, output));
}

function claudeInput(hookEvent, source, pluginRoot) {
  const common = {
    ...source,
    session_id: source.conversationId,
    transcript_path: source.transcriptPath,
    cwd: source.workspacePaths?.[0] ?? pluginRoot,
    hook_event_name: hookEvent,
  };
  if (hookEvent === "SessionStart") return { ...common, source: "startup" };
  if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") {
    return {
      ...common,
      tool_name: claudeToolName(source.toolCall?.name),
      tool_input: source.toolCall?.args ?? {},
      tool_response: source.toolCall?.result,
    };
  }
  if (hookEvent === "Stop") return { ...common, stop_hook_active: false };
  return common;
}

function parseOutput(hookEvent, stdout) {
  const text = stdout.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return (typeof parsed === "object" && parsed !== null) ? parsed : {};
  } catch (error) {
    if (hookEvent === "SessionStart") return { additionalContext: text };
    fail("hook command returned invalid JSON", error);
  }
}

function antigravityOutput(hookEvent, output) {
  if (output.continue === false) {
    const reason = output.stopReason ?? output.reason ?? "Claude hook stopped processing";
    if (hookEvent === "PreToolUse") return { decision: "deny", reason };
    if (hookEvent === "Stop") return { decision: "stop" };
    fail(hookEvent + " continue:false output has no safe Antigravity mapping", reason);
  }
  if (hookEvent === "SessionStart") {
    if (Array.isArray(output.injectSteps)) return output;
    const context = output.hookSpecificOutput?.additionalContext
      ?? output.additionalContext
      ?? output.additional_context;
    return typeof context === "string" && context ? { injectSteps: [{ ephemeralMessage: context }] } : {};
  }
  if (hookEvent === "PreToolUse") {
    const specific = output.hookSpecificOutput ?? {};
    const decision = specific.permissionDecision ?? output.permissionDecision ?? output.decision;
    const reason = specific.permissionDecisionReason ?? output.reason;
    if (specific.updatedInput !== undefined) {
      process.stderr.write("antigravity hook bridge: Claude updatedInput is unsupported; requesting confirmation\n");
      return { decision: "ask", reason: reason ?? "Hook requested a tool-input change that Antigravity cannot apply" };
    }
    if (decision === "deny" || decision === "block") return { decision: "deny", ...(reason ? { reason } : {}) };
    if (decision === "allow" || decision === "approve") return { decision: "allow", ...(reason ? { reason } : {}) };
    if (decision === "ask") return { decision: "ask", ...(reason ? { reason } : {}) };
    if (decision === "defer") {
      process.stderr.write("antigravity hook bridge: Claude defer is unsupported; requesting confirmation\n");
      return { decision: "ask", reason: reason ?? "Hook deferred to Antigravity's permission flow" };
    }
    return { decision: "allow", ...(reason ? { reason } : {}) };
  }
  if (hookEvent === "PostToolUse") {
    if (output.decision === "block") {
      fail("PostToolUse block output has no safe Antigravity mapping", output.reason ?? "block");
    }
    return {};
  }
  if (hookEvent === "Stop") {
    return output.decision === "block"
      ? { decision: "continue", ...(output.reason ? { reason: output.reason } : {}) }
      : { decision: "stop" };
  }
  return {};
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(message, error) {
  process.stderr.write("antigravity hook bridge: " + message + ": " + String(error) + "\n");
  process.exit(1);
}

// Only run the hook bridge when executed directly (`node hook-runner.mjs ...`),
// so the module can be imported for its pure exports (claudeToolName) in tests
// without reading stdin or spawning a child process. Realpath process.argv[1]
// first: import.meta.url is symlink-resolved by Node (e.g. macOS /tmp is a
// symlink to /private/tmp) but the literal argv[1] is not, so a plain string
// comparison between the two silently never matches on such systems.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
