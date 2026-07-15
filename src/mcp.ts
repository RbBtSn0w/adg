import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { AdgManifest } from "./types.ts";

/** ADG's canonical MCP config pointer. */
export function mcpConfigPath(manifest: AdgManifest): string | undefined {
  return manifest.mcpServers;
}

/** Filter the servers defined in the MCP config file. */
export function filterMcpConfig(file: string, allowedNames: string[]): void {
  if (!existsSync(file)) return;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    if (typeof json !== "object" || json === null) {
      throw new Error("MCP config root must be an object");
    }

    // Find and validate all defined server names
    const definedNames = new Set<string>();
    let hasMcpServersOrServers = false;
    for (const key of ["mcpServers", "servers"]) {
      const servers = (json as Record<string, unknown>)[key];
      if (servers !== undefined) {
        if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
          throw new Error(`MCP config "${key}" must be an object`);
        }
        hasMcpServersOrServers = true;
        for (const name of Object.keys(servers)) {
          definedNames.add(name);
        }
      }
    }

    if (allowedNames.length > 0 && !hasMcpServersOrServers) {
      throw new Error("MCP config does not define any servers");
    }

    const missing = allowedNames.filter((name) => !definedNames.has(name));
    if (missing.length > 0) {
      throw new Error(`selected mcp server(s) not declared: ${missing.join(", ")}`);
    }

    const allowed = new Set(allowedNames);
    let changed = false;
    for (const key of ["mcpServers", "servers"]) {
      const servers = (json as Record<string, unknown>)[key];
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        const obj = servers as Record<string, unknown>;
        const newObj: Record<string, unknown> = {};
        for (const [name, config] of Object.entries(obj)) {
          if (allowed.has(name)) {
            newObj[name] = config;
          } else {
            changed = true;
          }
        }
        (json as Record<string, unknown>)[key] = newObj;
      }
    }

    if (changed) {
      writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to filter MCP config at " + file + ": " + msg);
  }
}
