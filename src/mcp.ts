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
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const allowed = new Set(allowedNames);

    let changed = false;
    for (const key of ["mcpServers", "servers"]) {
      const servers = json[key];
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
        json[key] = newObj;
      }
    }

    if (changed) {
      writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
    }
  } catch {
    // Ignore parse/write failures gracefully.
  }
}
