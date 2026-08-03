import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdgManifest, PluginSelection } from "../types.ts";
import { isExposed } from "../components.ts";
import { extractMcpServers, mcpConfigPath } from "../mcp.ts";
import type { AdapterResult } from "./index.ts";

export const ANTIGRAVITY_MCP_CONFIG = "mcp_config.json";

const ANTIGRAVITY_MCP_SERVER_KEYS = new Set([
  "command",
  "serverUrl",
  "args",
  "env",
  "cwd",
  "headers",
  "authProviderType",
  "oauth",
  "disabled",
  "disabledTools",
]);

const ANTIGRAVITY_MCP_KEY_ALIASES: Record<string, string> = {
  url: "serverUrl",
  http_headers: "headers",
  disabled_tools: "disabledTools",
};

function toAntigravityMcpServer(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const source = value as Record<string, unknown>;
  const server: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(source)) {
    if (ANTIGRAVITY_MCP_SERVER_KEYS.has(key)) server[key] = field;
  }
  for (const [sourceKey, targetKey] of Object.entries(ANTIGRAVITY_MCP_KEY_ALIASES)) {
    if (server[targetKey] === undefined && source[sourceKey] !== undefined) {
      server[targetKey] = source[sourceKey];
    }
  }

  return server;
}

function toAntigravityMcpConfig(source: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;

  const servers = extractMcpServers(parsed);
  if (!servers) return parsed;

  const projected: Record<string, unknown> & { mcpServers: Record<string, unknown> } = {
    mcpServers: {},
  };
  for (const [name, value] of Object.entries(servers)) {
    projected.mcpServers[name] = toAntigravityMcpServer(value);
  }
  return projected;
}

/**
 * Generate an Antigravity (`agy`) plugin.json from an ADG manifest.
 *
 * Antigravity discovers a plugin by scanning a directory for a root `plugin.json`
 * plus sibling component dirs and `mcp_config.json`, so the manifest is emitted
 * at the plugin folder root and contains only the plugin name.
 */
export function toAntigravityManifest(
  _pluginDir: string,
  manifest: AdgManifest,
  _selection?: PluginSelection,
): AdapterResult {
  return { defaultPath: "plugin.json", manifest: { name: manifest.name } };
}

/** Materialize ADG's MCP pointer under Antigravity's required conventional name. */
export function writeAntigravityMcpConfig(
  pluginDir: string,
  manifest: AdgManifest,
  selection?: PluginSelection,
): void {
  const target = join(pluginDir, ANTIGRAVITY_MCP_CONFIG);
  const mcp = mcpConfigPath(manifest);
  const source = mcp ? resolve(pluginDir, mcp) : undefined;

  // An authored mcp_config.json is already the canonical payload, not a
  // generated projection. Never remove or copy it onto itself.
  if (source === resolve(target)) return;

  if (source && isExposed(selection, "mcp") && existsSync(source)) {
    const projected = `${JSON.stringify(toAntigravityMcpConfig(source), null, 2)}\n`;
    rmSync(target, { force: true });
    writeFileSync(target, projected);
    return;
  }
  rmSync(target, { force: true });
}
