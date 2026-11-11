import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ADAPTER_TARGETS, type AdapterTarget } from "./adapters/index.ts";
import { resolveClaudeHooksFile } from "./adapters/anthropic.ts";
import { resolveCodexHooksFile } from "./adapters/codex.ts";
import { writeAntigravityHooks } from "./adapters/antigravity-hooks.ts";
import { writeAntigravityMcpConfig } from "./adapters/antigravity.ts";
import { isExposed } from "./components.ts";
import { extractMcpServers, mcpConfigPath } from "./mcp.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import type { AdgManifest, PluginSelection } from "./types.ts";

export interface ExecutableEntry {
  id: string;
  label: string;
  component: "hooks" | "mcp";
  member: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function configFile(dir: string, file: string): unknown {
  const path = resolve(dir, file);
  const rel = relative(realpathSync(dir), existsSync(path) ? realpathSync(path) : path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Executable config must remain inside its plugin");
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new Error("Executable config is missing or invalid JSON"); }
}

function validateHandler(value: unknown): void {
  if (!record(value)) throw new Error("Invalid executable hook handler");
  const type = value.type ?? "command";
  const fields: Record<string, string[]> = {
    command: ["command"], http: ["url"], prompt: ["prompt"], agent: ["prompt"], mcp_tool: ["server", "tool"],
  };
  const required = typeof type === "string" && Object.hasOwn(fields, type) ? fields[type] : undefined;
  if (!required || !required.every(key => typeof value[key] === "string" && value[key].trim())) {
    throw new Error("Invalid executable hook handler");
  }
}

/** Inventory effective runtime configs, without executing their commands or mutating the source. */
export function executableInventory(
  dir: string, manifest: AdgManifest, selection?: PluginSelection,
  targets: AdapterTarget[] = [...ADAPTER_TARGETS],
): ExecutableEntry[] {
  const entries = new Map<string, ExecutableEntry>();
  const occurrences = new Map<string, number>();
  const add = (target: AdapterTarget, component: "hooks" | "mcp", member: string, value: unknown, label: string) => {
    const identity = digest({ target, component, member, value });
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const id = `sha256-${digest({ identity, occurrence })}`;
    entries.set(id, { id, component, member, label: `${target} ${label}` });
  };
  const mcp = (root: string, file: string, target: AdapterTarget) => {
    const document = configFile(root, file);
    const servers = extractMcpServers(document);
    if (!servers) throw new Error("Invalid executable MCP config");
    for (const name of Object.keys(servers).sort()) {
      if (selection?.mcp && !selection.mcp.includes(name)) continue;
      const server = servers[name];
      if (!record(server) || !["command", "url", "serverUrl"].some((key) => typeof server[key] === "string" && server[key].trim())) {
        throw new Error("Invalid executable MCP server");
      }
      const safeName = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/i.test(name) && name.length <= 40
        && !/(?:token|secret|password|credential)|[a-f0-9]{20}/i.test(name) ? name : "configured service";
      add(target, "mcp", name, server, `MCP service ${safeName}`);
    }
  };
  const hooks = (root: string, file: string, target: AdapterTarget, native = false, validateOnly = false) => {
    const document = configFile(root, file);
    if (!record(document)) throw new Error("Invalid executable hooks config");
    const shared = Object.fromEntries(Object.entries(document).filter(([key]) => key !== "hooks"));
    const consume = (handler: unknown, event: string, context: unknown) => {
      validateHandler(handler);
      const eventLabel = /^(?:SessionStart|PreInvocation|PreToolUse|PostToolUse|Stop|UserPromptSubmit|SessionEnd|Notification|PermissionRequest|SubagentStart|SubagentStop|PreCompact|Setup|TaskCompleted|TeammateIdle|ConfigChange|WorktreeCreate|WorktreeRemove)$/.test(event)
        ? event : "configured event";
      if (!validateOnly) add(target, "hooks", file.replace(/^\.\//, ""), { event, context, handler }, `${eventLabel} hook`);
    };
    if (native) {
      for (const definition of Object.values(document)) {
        if (!record(definition)) throw new Error("Invalid native executable hooks config");
        for (const [event, groups] of Object.entries(definition)) {
          if (event === "enabled") continue;
          if (!Array.isArray(groups)) throw new Error("Invalid native executable hooks event");
          for (const item of groups) {
            if (record(item) && Array.isArray(item.hooks)) for (const handler of item.hooks) consume(handler, event, {
              settings: Object.fromEntries(Object.entries(item).filter(([key]) => key !== "hooks")), enabled: definition.enabled,
            });
            else consume(item, event, { enabled: definition.enabled });
          }
        }
      }
    } else {
      if (!record(document.hooks)) throw new Error("Invalid executable hooks event map");
      for (const [event, groups] of Object.entries(document.hooks)) {
        if (!Array.isArray(groups)) throw new Error("Invalid executable hooks event");
        for (const group of groups) {
          if (!record(group) || !Array.isArray(group.hooks)) throw new Error("Invalid executable hooks group");
          for (const handler of group.hooks) consume(handler, event, {
            shared, group: Object.fromEntries(Object.entries(group).filter(([key]) => key !== "hooks")),
          });
        }
      }
    }
  };
  for (const target of new Set(targets)) {
    if (!ADAPTER_TARGETS.includes(target)) throw new Error("Unsupported executable runtime target");
    if (target === "antigravity") {
      if (!(isExposed(selection, "hooks") && manifest.hooks) && !(isExposed(selection, "mcp") && mcpConfigPath(manifest))) continue;
      // Reuse the actual adapter's native overrides and alias projection. Stable
      // runtimeRoot keeps identical payloads independent of staging locations.
      const temporary = mkdtempSync(join(tmpdir(), "adg-executable-inventory-"));
      try {
        const scratch = join(temporary, "plugin");
        cpSync(dir, scratch, { recursive: true, filter(source) {
          if (lstatSync(source).isSymbolicLink()) throw new Error("Cannot verify symlinked executable payload");
          return relative(dir, source).split(sep)[0] !== ".git";
        } });
        if (isExposed(selection, "hooks") && manifest.hooks) {
          const declared = resolve(scratch, manifest.hooks);
          const directory = existsSync(declared) && statSync(declared).isDirectory();
          const native = directory ? join(declared, "hooks-antigravity.json") : undefined;
          if (!native || !existsSync(native)) {
            const source = directory ? join(declared, "hooks.json") : declared;
            if (!source.endsWith("hooks-antigravity.json")) {
              hooks(scratch, relative(scratch, source), target, source === join(scratch, "hooks.json"), true);
            }
          }
          writeAntigravityHooks(scratch, manifest, selection, "/ADG_PLUGIN_ROOT");
          if (existsSync(join(scratch, "hooks.json"))) hooks(scratch, "hooks.json", target, true);
        }
        if (isExposed(selection, "mcp") && mcpConfigPath(manifest)) {
          writeAntigravityMcpConfig(scratch, manifest, selection);
          mcp(scratch, "mcp_config.json", target);
        }
      } catch { throw new Error("Cannot verify effective Antigravity executable config"); }
      finally { rmSync(temporary, { recursive: true, force: true }); }
      continue;
    }
    if (isExposed(selection, "mcp") && mcpConfigPath(manifest)) mcp(dir, mcpConfigPath(manifest)!, target);
    if (isExposed(selection, "hooks")) {
      const files = new Set<string>();
      if (target === "claude" && existsSync(join(dir, "hooks/hooks.json"))) files.add("hooks/hooks.json");
      if (manifest.hooks) {
        const file = target === "claude" ? resolveClaudeHooksFile(dir, manifest.hooks) : resolveCodexHooksFile(dir, manifest.hooks);
        if (file) files.add(file.replace(/^\.\//, ""));
        else if (target === "codex" || !existsSync(join(dir, manifest.hooks.replace(/\/+$/, ""), "hooks.json"))) {
          if (!(target === "claude" && manifest.hooks.replace(/^\.\//, "") === "hooks/hooks.json" && existsSync(join(dir, "hooks/hooks.json")))) {
            throw new Error("Cannot resolve executable hooks config");
          }
        }
      }
      for (const file of files) hooks(dir, file, target);
    }
  }
  recordTelemetryEvent("adg.update.executables.inventory", { "executables.count": entries.size, "runtimes.count": new Set(targets).size });
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}
