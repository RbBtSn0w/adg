import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { AdgManifest } from "./types.ts";

/** ADG's canonical MCP config pointer. */
export function mcpConfigPath(manifest: AdgManifest): string | undefined {
  return manifest.mcpServers;
}

const MCP_SERVER_DISCRIMINATOR_KEYS = new Set([
  "command",
  "url",
  "serverUrl",
  "type",
  "args",
  "env",
  "headers",
  "http_headers",
  "cwd",
]);

function isMcpServerConfig(val: unknown): boolean {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return Object.keys(obj).some((k) => MCP_SERVER_DISCRIMINATOR_KEYS.has(k));
}

/** Extract the MCP servers map from canonical, legacy, or flat server map roots. */
export function extractMcpServers(json: unknown): Record<string, unknown> | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj.servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return servers as Record<string, unknown>;
  }
  const keys = Object.keys(obj);
  if (keys.length > 0) {
    const isServerMap = keys.every((k) => isMcpServerConfig(obj[k]));
    if (isServerMap) return obj;
  }
  return undefined;
}

/** Filter the servers defined in the MCP config file. */
export function filterMcpConfig(file: string, allowedNames: string[]): void {
  if (!existsSync(file)) return;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const servers = extractMcpServers(json);
    if (!servers) {
      throw new Error("MCP config root must be an object");
    }

    const definedNames = new Set(Object.keys(servers));

    if (allowedNames.length > 0 && definedNames.size === 0) {
      throw new Error("MCP config does not define any servers");
    }

    const missing = allowedNames.filter((name) => !definedNames.has(name));
    if (missing.length > 0) {
      throw new Error(`selected mcp server(s) not declared: ${missing.join(", ")}`);
    }

    const allowed = new Set(allowedNames);
    const newServers: Record<string, unknown> = {};
    let changed = false;
    for (const [name, config] of Object.entries(servers)) {
      if (allowed.has(name)) {
        newServers[name] = config;
      } else {
        changed = true;
      }
    }

    if (changed) {
      const root = json as Record<string, unknown>;
      if (root.mcpServers && typeof root.mcpServers === "object") {
        root.mcpServers = newServers;
      } else if (root.servers && typeof root.servers === "object") {
        root.servers = newServers;
      } else {
        // Flat server map: update in-place
        for (const key of Object.keys(root)) {
          if (!allowed.has(key)) delete root[key];
        }
      }
      writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to filter MCP config at " + file + ": " + msg);
  }
}

