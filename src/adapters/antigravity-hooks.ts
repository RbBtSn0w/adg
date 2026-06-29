import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isExposed } from "../components.ts";
import { writeJson, writeText } from "../fsutil.ts";
import type { AdgManifest, PluginSelection } from "../types.ts";

const TARGET_FILE = "hooks.json";
const PROJECTION_DIR = ".antigravity-plugin";
const RUNNER_FILE = "hook-runner.mjs";
const NATIVE_OVERRIDE = "hooks-antigravity.json";

const EVENT_MAP = {
  SessionStart: "PreInvocation",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  Stop: "Stop",
} as const;

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: "run_command",
  Read: "view_file",
  Write: "write_to_file",
  Edit: "replace_file_content|multi_replace_file_content",
  Glob: "find_by_name",
  Grep: "grep_search",
  WebSearch: "search_web",
  WebFetch: "read_url_content",
  Agent: "invoke_subagent",
  AskUserQuestion: "ask_question",
};

const ANTIGRAVITY_TOOL_NAMES = new Set(Object.values(TOOL_ALIASES).flatMap((name) => name.split("|")));
const ANTIGRAVITY_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const ANTIGRAVITY_DIRECT_EVENTS = new Set(["PreInvocation", "PostInvocation", "Stop"]);

interface ClaudeHandler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  async?: unknown;
}

interface ClaudeGroup {
  matcher?: unknown;
  hooks?: unknown;
}

interface ClaudeHooksDocument {
  hooks?: unknown;
}

interface AntigravityHandler {
  type: "command";
  command: string;
  timeout: number;
}

interface AntigravityToolGroup {
  matcher: string;
  hooks: AntigravityHandler[];
}

type AntigravityEventValue = AntigravityHandler[] | AntigravityToolGroup[];

interface HookSources {
  canonical?: string;
  native?: string;
}

function hookSources(pluginDir: string, manifest: AdgManifest): HookSources {
  if (!manifest.hooks) return {};
  const declared = resolve(pluginDir, manifest.hooks);
  if (existsSync(declared) && statSync(declared).isDirectory()) {
    const native = join(declared, NATIVE_OVERRIDE);
    const canonical = join(declared, TARGET_FILE);
    return {
      ...(existsSync(canonical) ? { canonical } : {}),
      ...(existsSync(native) ? { native } : {}),
    };
  }
  if (basename(declared) === NATIVE_OVERRIDE) return { native: declared };
  return { canonical: declared };
}

function cleanupGenerated(pluginDir: string, preserveTarget = false): void {
  if (!preserveTarget) rmSync(join(pluginDir, TARGET_FILE), { force: true });
  rmSync(join(pluginDir, PROJECTION_DIR, RUNNER_FILE), { force: true });
}

function parseJsonFile(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid ${label} JSON in ${file}: ${String(error)}`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNativeHandler(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`invalid native Antigravity hooks schema: ${path} must be an object`);
  if ((value.type ?? "command") !== "command") {
    throw new Error(`invalid native Antigravity hooks schema: ${path}.type must be "command"`);
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    throw new Error(`invalid native Antigravity hooks schema: ${path}.command must be a non-empty string`);
  }
  if (value.timeout !== undefined && (!Number.isInteger(value.timeout) || (value.timeout as number) <= 0)) {
    throw new Error(`invalid native Antigravity hooks schema: ${path}.timeout must be a positive integer`);
  }
}

function validateNativeHandlers(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`invalid native Antigravity hooks schema: ${path} must be a non-empty array`);
  }
  value.forEach((handler, index) => validateNativeHandler(handler, `${path}[${index}]`));
}

function validateNativeDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("invalid native Antigravity hooks schema: root must be a non-empty object");
  }
  for (const [hookName, rawDefinition] of Object.entries(value)) {
    if (!isRecord(rawDefinition)) {
      throw new Error(`invalid native Antigravity hooks schema: hook "${hookName}" must be an object`);
    }
    let eventCount = 0;
    for (const [field, eventValue] of Object.entries(rawDefinition)) {
      if (field === "enabled") {
        if (typeof eventValue !== "boolean") {
          throw new Error(`invalid native Antigravity hooks schema: ${hookName}.enabled must be boolean`);
        }
        continue;
      }
      if (ANTIGRAVITY_DIRECT_EVENTS.has(field)) {
        validateNativeHandlers(eventValue, `${hookName}.${field}`);
        eventCount += 1;
        continue;
      }
      if (ANTIGRAVITY_TOOL_EVENTS.has(field)) {
        if (!Array.isArray(eventValue) || eventValue.length === 0) {
          throw new Error(`invalid native Antigravity hooks schema: ${hookName}.${field} must be a non-empty array`);
        }
        eventValue.forEach((rawGroup, groupIndex) => {
          const path = `${hookName}.${field}[${groupIndex}]`;
          if (!isRecord(rawGroup)) throw new Error(`invalid native Antigravity hooks schema: ${path} must be an object`);
          if (rawGroup.matcher !== undefined && typeof rawGroup.matcher !== "string") {
            throw new Error(`invalid native Antigravity hooks schema: ${path}.matcher must be a string`);
          }
          validateNativeHandlers(rawGroup.hooks, `${path}.hooks`);
        });
        eventCount += 1;
        continue;
      }
      throw new Error(`invalid native Antigravity hooks schema: unknown field ${hookName}.${field}`);
    }
    if (eventCount === 0) {
      throw new Error(`invalid native Antigravity hooks schema: hook "${hookName}" declares no events`);
    }
  }
}

function replaceJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeJson(temporary, value);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function replaceText(file: string, value: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeText(temporary, value);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function replaceFile(file: string, source: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    cpSync(source, temporary);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseGroups(value: unknown): ClaudeGroup[] {
  return Array.isArray(value) ? value.filter((group): group is ClaudeGroup => typeof group === "object" && group !== null) : [];
}

function matcherIncludesStartup(matcher: unknown): boolean {
  if (matcher === undefined || matcher === "") return true;
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test("startup");
  } catch {
    return false;
  }
}

function translateToolMatcher(matcher: unknown): string | undefined {
  if (matcher === undefined || matcher === "" || matcher === "*") return typeof matcher === "string" ? matcher : "";
  if (typeof matcher !== "string") return undefined;
  const tokens = matcher.split("|");
  if (tokens.some((token) => !/^[A-Za-z0-9_]+$/.test(token))) return undefined;
  const translated: string[] = [];
  for (const token of tokens) {
    const alias = TOOL_ALIASES[token];
    if (alias) translated.push(alias);
    else if (ANTIGRAVITY_TOOL_NAMES.has(token)) translated.push(token);
    else return undefined;
  }
  return translated.join("|");
}

function runnerCommand(pluginDir: string, event: keyof typeof EVENT_MAP, command: string): string {
  const encoded = Buffer.from(command, "utf8").toString("base64url");
  const runner = join(resolve(pluginDir), PROJECTION_DIR, RUNNER_FILE);
  const quotedRunner = process.platform === "win32"
    ? `"${runner.replaceAll("/", "\\")}"`
    : `'${runner.replaceAll("'", `'"'"'`)}'`;
  return `node ${quotedRunner} ${event} ${encoded}`;
}

function translateHandlers(
  pluginDir: string,
  pluginName: string,
  event: keyof typeof EVENT_MAP,
  value: unknown,
  warnings: string[],
): AntigravityHandler[] {
  if (!Array.isArray(value)) return [];
  const translated: AntigravityHandler[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const handler = raw as ClaudeHandler;
    if ((handler.type ?? "command") !== "command") {
      warnings.push(`${pluginName}: ${event} handler type "${String(handler.type)}" is not supported by antigravity`);
      continue;
    }
    if (handler.async === true) {
      warnings.push(`${pluginName}: async ${event} command handlers are not supported by antigravity`);
      continue;
    }
    if (typeof handler.command !== "string" || !handler.command.trim()) {
      warnings.push(`${pluginName}: ${event} command handler has no command`);
      continue;
    }
    const timeout = typeof handler.timeout === "number" && Number.isInteger(handler.timeout) && handler.timeout > 0
      ? handler.timeout
      : 30;
    translated.push({ type: "command", command: runnerCommand(pluginDir, event, handler.command), timeout });
  }
  return translated;
}

function translateDirectEvent(
  pluginDir: string,
  pluginName: string,
  event: "SessionStart" | "Stop",
  groups: ClaudeGroup[],
  warnings: string[],
): AntigravityHandler[] {
  const handlers: AntigravityHandler[] = [];
  for (const group of groups) {
    if (event === "SessionStart" && !matcherIncludesStartup(group.matcher)) {
      warnings.push(`${pluginName}: SessionStart matcher "${String(group.matcher)}" has no Antigravity startup mapping`);
      continue;
    }
    handlers.push(...translateHandlers(pluginDir, pluginName, event, group.hooks, warnings));
  }
  return handlers;
}

function translateToolEvent(
  pluginDir: string,
  pluginName: string,
  event: "PreToolUse" | "PostToolUse",
  groups: ClaudeGroup[],
  warnings: string[],
): AntigravityToolGroup[] {
  const translated: AntigravityToolGroup[] = [];
  for (const group of groups) {
    const matcher = translateToolMatcher(group.matcher);
    if (matcher === undefined) {
      warnings.push(`${pluginName}: ${event} matcher "${String(group.matcher)}" cannot be safely mapped to antigravity`);
      continue;
    }
    const hooks = translateHandlers(pluginDir, pluginName, event, group.hooks, warnings);
    if (hooks.length) translated.push({ matcher, hooks });
  }
  return translated;
}

function translateDocument(pluginDir: string, pluginName: string, document: ClaudeHooksDocument): {
  definition: Record<string, AntigravityEventValue>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const definition: Record<string, AntigravityEventValue> = {};
  const hooks = typeof document.hooks === "object" && document.hooks !== null
    ? document.hooks as Record<string, unknown>
    : {};

  for (const event of Object.keys(hooks)) {
    if (!(event in EVENT_MAP)) {
      warnings.push(`hook event "${event}" is not a supported antigravity hook mapping — antigravity will not fire it`);
    }
  }

  const sessionStart = translateDirectEvent(pluginDir, pluginName, "SessionStart", parseGroups(hooks.SessionStart), warnings);
  if (sessionStart.length) definition.PreInvocation = sessionStart;
  const preToolUse = translateToolEvent(pluginDir, pluginName, "PreToolUse", parseGroups(hooks.PreToolUse), warnings);
  if (preToolUse.length) definition.PreToolUse = preToolUse;
  const postToolUse = translateToolEvent(pluginDir, pluginName, "PostToolUse", parseGroups(hooks.PostToolUse), warnings);
  if (postToolUse.length) definition.PostToolUse = postToolUse;
  const stop = translateDirectEvent(pluginDir, pluginName, "Stop", parseGroups(hooks.Stop), warnings);
  if (stop.length) definition.Stop = stop;

  return { definition, warnings };
}

/** Materialize a plugin's hooks under Antigravity's required root filename and native schema. */
export function writeAntigravityHooks(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): string[] {
  const target = join(pluginDir, TARGET_FILE);
  const sources = hookSources(pluginDir, manifest);
  const sourceIsTarget = sources.canonical !== undefined && resolve(sources.canonical) === resolve(target);

  if (!isExposed(selection, "hooks") || (!sources.native && !sources.canonical)) {
    cleanupGenerated(pluginDir, sourceIsTarget);
    return [];
  }
  if (sourceIsTarget) {
    rmSync(join(pluginDir, PROJECTION_DIR, RUNNER_FILE), { force: true });
    return [];
  }

  if (sources.native) {
    const document = parseJsonFile(sources.native, "native Antigravity hooks");
    validateNativeDocument(document);
    replaceFile(target, sources.native);
    rmSync(join(pluginDir, PROJECTION_DIR, RUNNER_FILE), { force: true });
    return [];
  }

  const document = parseJsonFile(sources.canonical!, "canonical hooks") as ClaudeHooksDocument;
  const { definition, warnings } = translateDocument(pluginDir, manifest.name, document);
  if (Object.keys(definition).length) {
    const projected = { [manifest.name]: definition };
    validateNativeDocument(projected);
    replaceText(join(pluginDir, PROJECTION_DIR, RUNNER_FILE), HOOK_RUNNER);
    replaceJson(target, projected);
  } else {
    cleanupGenerated(pluginDir);
  }
  return warnings;
}

const HOOK_RUNNER = String.raw`import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  .replaceAll("$" + "{CLAUDE_PLUGIN_ROOT}", pluginRoot)
  .replaceAll("$" + "{PLUGIN_ROOT}", pluginRoot);
const childInput = claudeInput(event, input);
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

function claudeInput(hookEvent, source) {
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

function claudeToolName(name) {
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
`;
