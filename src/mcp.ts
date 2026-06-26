import type { AdgManifest } from "./types.ts";

/** ADG's canonical MCP config pointer. */
export function mcpConfigPath(manifest: AdgManifest): string | undefined {
  return manifest.mcpServers;
}
