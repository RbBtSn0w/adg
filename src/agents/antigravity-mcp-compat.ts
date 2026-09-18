import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ANTIGRAVITY_MCP_CONFIG } from "../adapters/antigravity.ts";
import { extractMcpServers, mcpConfigPath } from "../mcp.ts";
import { findManifestFile, readManifest } from "../manifest.ts";
import type { AgentPruneResult, StaleRegistration } from "./types.ts";

/**
 * @module antigravity-mcp-compat
 *
 * [COMPATIBILITY SHIM / ANTI-CORRUPTION LAYER FOR ANTIGRAVITY RUNTIMES]
 *
 * 存在原因 (Why this exists):
 * Antigravity 采用被动的物理目录扫描机制（Physical-directory discovery model）。
 * 激活插件时，Antigravity 的 Language Server 会在启动阶段自发连接 MCP 并将生成的
 * 工具 Schema 写入各个宿主环境的私有缓存目录（~/.gemini/<marker>/mcp/），并在
 * ~/.gemini/config/config.json 中记录启用状态。
 *
 * 当 ADG 停用、取消链接或卸载插件时，Antigravity 自身缺乏对“外部软链接被删除”进行
 * 自动垃圾回收（Deep GC）的能力，导致残存的工具 Schema 依然被 Antigravity 加载为
 * 有效工具（幽灵工具），引发上下文污染与调用失败。
 *
 * 核心职责 (Scope):
 * 1. 垃圾回收多宿主环境（antigravity, antigravity-cli, antigravity-ide）下残留的 MCP 目录。
 * 2. 严格遵循“全局配置白名单”与“多插件活跃共享白名单”，防止误删用户全局配置与其他插件依赖。
 * 3. 状态对齐 ~/.gemini/config/config.json 中的 plugins.<name>.enabled。
 *
 * 退役 / 演进路线 (Retirement / Evolution Path):
 * 未来本兼容模块可按以下路径逐步抛弃或解耦：
 * 1. 【原生支持退役】：当 Google Antigravity 原生支持了外部目录删除自动清理或官方 CLI 反注册时，
 *    直接删除本文件并移除 src/agents/antigravity.ts 中的两处调用即可。
 * 2. 【收敛至诊断层】：亦可轻松迁移至 `adg doctor` 或 `adg plugins cache prune` 作为独立的孤儿工具清理逻辑。
 */

/** Antigravity runtime markers under the Gemini home. */
const COMPAT_ANTIGRAVITY_MARKERS = ["antigravity", "antigravity-cli", "antigravity-ide"] as const;

/** Conventional manifest name scanned by Antigravity at plugin roots. */
const ANTIGRAVITY_MANIFEST = "plugin.json";

function compatGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_HOME?.trim() || join(homedir(), ".gemini");
}

/**
 * Safely extract all MCP server names declared by a plugin directory, supporting both
 * ADG manifests (.agents/.plugin.json) and native Antigravity configs (mcp_config.json, .mcp.json).
 */
function collectPluginServers(
  pluginDir: string,
  exists: (path: string) => boolean = existsSync,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
): Set<string> {
  const servers = new Set<string>();
  if (!exists(pluginDir)) return servers;

  const candidates: string[] = [];

  try {
    if (findManifestFile(pluginDir)) {
      const manifest = readManifest(pluginDir);
      const mcp = mcpConfigPath(manifest);
      if (mcp) candidates.push(resolve(pluginDir, mcp));
    }
  } catch {
    // Ignore invalid ADG manifest; continue to probe native files below
  }

  candidates.push(join(pluginDir, ANTIGRAVITY_MCP_CONFIG));
  candidates.push(join(pluginDir, ".mcp.json"));

  for (const candidate of candidates) {
    if (exists(candidate)) {
      try {
        const raw = readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        const extracted = extractMcpServers(parsed);
        if (extracted) {
          for (const s of Object.keys(extracted)) servers.add(s);
        }
      } catch {
        // Ignore unparseable candidate
      }
    }
  }

  return servers;
}

/**
 * Update the plugin's enablement state in Antigravity's ~/.gemini/config/config.json
 * when that file is present.
 */
export function syncAntigravityPluginConfig(
  name: string,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configPath = join(compatGeminiHome(env), "config", "config.json");
  if (!existsSync(configPath)) return;
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.plugins &&
      typeof parsed.plugins === "object" &&
      !Array.isArray(parsed.plugins)
    ) {
      const plugins = parsed.plugins as Record<string, { enabled?: boolean }>;
      if (plugins[name] || !enabled) {
        plugins[name] = { ...plugins[name], enabled };
        writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    }
  } catch {
    // Best-effort; avoid throwing if config.json is malformed
  }
}

/**
 * Remove Antigravity runtime MCP tool schema directories (<marker>/mcp/) created for
 * a plugin when that plugin is deactivated. Never removes servers declared in the
 * global ~/.gemini/config/mcp_config.json or by other active plugins.
 */
export function cleanupAntigravityMcp(
  name: string,
  scanDir: string,
  realDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const home = compatGeminiHome(env);

  // 1. Collect MCP server names declared by this plugin (if realDir is accessible).
  const declaredServers = realDir ? collectPluginServers(realDir) : new Set<string>();

  // 2. Collect servers declared in global mcp_config.json (must NEVER be deleted).
  const globalServers = new Set<string>();
  const globalMcpFile = join(home, "config", "mcp_config.json");
  if (existsSync(globalMcpFile)) {
    try {
      const parsed = JSON.parse(readFileSync(globalMcpFile, "utf8")) as unknown;
      const servers = extractMcpServers(parsed);
      if (servers) {
        for (const s of Object.keys(servers)) globalServers.add(s);
      }
    } catch {
      // ignore
    }
  }

  // 3. Collect servers declared by any other active plugin in scanDir.
  const otherPluginServers = new Set<string>();
  if (existsSync(scanDir)) {
    try {
      for (const entry of readdirSync(scanDir)) {
        if (entry === name) continue;
        const entryDir = join(scanDir, entry);
        if (existsSync(join(entryDir, ANTIGRAVITY_MANIFEST))) {
          for (const s of collectPluginServers(entryDir)) {
            otherPluginServers.add(s);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Sweep each runtime directory's mcp/ folder.
  const prefix = `${name}_`;
  for (const marker of COMPAT_ANTIGRAVITY_MARKERS) {
    const mcpDir = join(home, marker, "mcp");
    if (!existsSync(mcpDir)) continue;
    try {
      for (const entry of readdirSync(mcpDir)) {
        if (entry.startsWith(".")) continue;

        const fullPath = join(mcpDir, entry);
        if (!resolve(fullPath).startsWith(resolve(mcpDir) + sep)) continue;

        // Plugin-prefixed server (e.g. appscope_appscope, xcode_xcrun-mcp): uniquely owned
        if (entry.startsWith(prefix)) {
          rmSync(fullPath, { recursive: true, force: true });
          continue;
        }

        // Bare plugin name (e.g. appscope)
        if (entry === name) {
          if (!globalServers.has(entry) && !otherPluginServers.has(entry)) {
            rmSync(fullPath, { recursive: true, force: true });
          }
          continue;
        }

        // Bare server name declared by this plugin (e.g. xcrun-mcp)
        if (declaredServers.has(entry)) {
          if (!globalServers.has(entry) && !otherPluginServers.has(entry)) {
            rmSync(fullPath, { recursive: true, force: true });
          }
          continue;
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Public facade: Reconcile Antigravity runtime state when a plugin is activated.
 */
export function reconcileAntigravityActivation(name: string, env: NodeJS.ProcessEnv = process.env): void {
  syncAntigravityPluginConfig(name, true, env);
}

/**
 * Public facade: Reconcile Antigravity runtime state when a plugin is deactivated.
 */
export function reconcileAntigravityDeactivation(
  name: string,
  scanDir: string,
  realDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  cleanupAntigravityMcp(name, scanDir, realDir, env);
  syncAntigravityPluginConfig(name, false, env);
}

export interface PruneAntigravityOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
  removeDir?: (path: string) => void;
  readFile?: (path: string, encoding: "utf8") => string;
  writeFile?: (path: string, data: string) => void;
  projectPluginsDir?: string;
}

/**
 * Sweep Antigravity runtime directories (<marker>/mcp/) for orphaned tool schema directories
 * left behind by uninstalled or renamed plugins, and align ~/.gemini/config/config.json.
 * Safe: strictly preserves servers in ~/.gemini/config/mcp_config.json and all active plugins.
 */
export function pruneStaleAntigravity(opts: PruneAntigravityOptions = {}): AgentPruneResult {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const readDir = opts.readDir ?? ((p) => (exists(p) ? readdirSync(p) : []));
  const removeDir = opts.removeDir ?? ((p) => rmSync(p, { recursive: true, force: true }));
  const readFile = opts.readFile ?? ((p, enc) => readFileSync(p, enc));
  const writeFile = opts.writeFile ?? ((p, d) => writeFileSync(p, d));

  const home = compatGeminiHome(env);
  const isPresent = COMPAT_ANTIGRAVITY_MARKERS.some((marker) => exists(join(home, marker)));
  if (!isPresent) {
    return { agent: "antigravity", skipped: true, removed: [], errors: [] };
  }

  const removed: StaleRegistration[] = [];
  const errors: string[] = [];

  // 1. Whitelist: Globally declared servers that must NEVER be deleted.
  const retainedServers = new Set<string>();
  const globalMcpFile = join(home, "config", "mcp_config.json");
  if (exists(globalMcpFile)) {
    try {
      const parsed = JSON.parse(readFile(globalMcpFile, "utf8")) as unknown;
      const servers = extractMcpServers(parsed);
      if (servers) {
        for (const s of Object.keys(servers)) retainedServers.add(s);
      }
    } catch {
      // ignore
    }
  }

  // 2. Whitelist: Servers and prefixes from all active plugins in global scanDir and optional projectPluginsDir.
  const retainedPluginNames = new Set<string>();
  const retainedPrefixes = new Set<string>();

  const scanDirs: string[] = [join(home, "config", "plugins")];
  if (opts.projectPluginsDir) {
    scanDirs.push(opts.projectPluginsDir);
  } else {
    const cwdProjectPlugins = resolve(process.cwd(), ".agents", "plugins");
    if (exists(cwdProjectPlugins)) {
      scanDirs.push(cwdProjectPlugins);
    }
  }

  for (const scanDir of scanDirs) {
    if (!exists(scanDir)) continue;
    try {
      for (const entry of readDir(scanDir)) {
        const entryDir = join(scanDir, entry);
        if (!exists(join(entryDir, ANTIGRAVITY_MANIFEST))) continue;
        retainedPluginNames.add(entry);
        retainedPrefixes.add(`${entry}_`);
        for (const s of collectPluginServers(entryDir, exists, readFile)) {
          retainedServers.add(s);
          retainedServers.add(`${entry}_${s}`);
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Sweep all runtime marker mcp directories and remove orphans.
  for (const marker of COMPAT_ANTIGRAVITY_MARKERS) {
    const mcpDir = join(home, marker, "mcp");
    if (!exists(mcpDir)) continue;
    try {
      for (const entry of readDir(mcpDir)) {
        if (entry.startsWith(".")) continue;

        const fullPath = join(mcpDir, entry);
        if (!resolve(fullPath).startsWith(resolve(mcpDir) + sep)) continue;

        if (retainedServers.has(entry)) continue;
        if (retainedPluginNames.has(entry)) continue;

        let hasMatchingPrefix = false;
        for (const p of retainedPrefixes) {
          if (entry.startsWith(p)) {
            hasMatchingPrefix = true;
            break;
          }
        }
        if (hasMatchingPrefix) continue;

        try {
          removeDir(fullPath);
          removed.push({ name: entry, path: fullPath });
        } catch (err) {
          errors.push(
            `failed to remove stale Antigravity MCP directory "${fullPath}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Align ~/.gemini/config/config.json plugin enablement states.
  const configPath = join(home, "config", "config.json");
  if (exists(configPath)) {
    try {
      const raw = readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.plugins &&
        typeof parsed.plugins === "object" &&
        !Array.isArray(parsed.plugins)
      ) {
        const plugins = parsed.plugins as Record<string, { enabled?: boolean }>;
        let modified = false;
        for (const [pName, pConf] of Object.entries(plugins)) {
          if (pConf && pConf.enabled && !retainedPluginNames.has(pName)) {
            pConf.enabled = false;
            modified = true;
          }
        }
        if (modified) {
          writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
        }
      }
    } catch {
      // ignore
    }
  }

  return { agent: "antigravity", skipped: false, removed, errors };
}

