import { installedPluginDir } from "../paths.ts";
import { agentsForComponents } from "../agents/index.ts";
import { COMPONENT_TYPES, type ComponentType } from "../types.ts";
import type { ListedPlugin, PluginContents } from "../commands/list.ts";
import type { AgentStatus } from "../commands/status.ts";
import type { AgentScope } from "../agents/index.ts";
import type { AdapterTarget } from "../adapters/index.ts";

type CountMap = Record<ComponentType, number>;

export interface PluginsListJson {
  pluginsDir: string;
  plugins: Array<{
    name: string;
    version: string;
    source: ListedPlugin["origin"];
    folderHash: string;
    installedAt: string;
    updatedAt: string;
    path: string;
    agents: string[];
    contents: PluginContents;
    counts: CountMap;
    partial: boolean;
  }>;
}

export interface PluginsStatusJson {
  pluginsDir: string;
  scope: AgentScope;
  targets: AdapterTarget[];
  statuses: AgentStatus[];
}

function normalizedContents(contents: PluginContents | undefined): PluginContents {
  return Object.fromEntries(COMPONENT_TYPES.map((type) => [type, contents?.[type] ?? []])) as PluginContents;
}

function contentCounts(contents: PluginContents): CountMap {
  return Object.fromEntries(COMPONENT_TYPES.map((type) => [type, contents[type].length])) as CountMap;
}

function contentTypes(contents: PluginContents): ComponentType[] {
  return COMPONENT_TYPES.filter((type) => contents[type].length > 0);
}

/** Stable machine-readable shape for `adg plugins list --json`. */
export function pluginsListJson(plugins: ListedPlugin[], pluginsDir: string): PluginsListJson {
  return {
    pluginsDir,
    plugins: plugins.map((plugin) => {
      const contents = normalizedContents(plugin.contents);
      return {
        name: plugin.name,
        version: plugin.version,
        source: plugin.origin,
        folderHash: plugin.folderHash,
        installedAt: plugin.installedAt,
        updatedAt: plugin.updatedAt,
        path: installedPluginDir(pluginsDir, plugin.name, plugin.origin),
        agents: agentsForComponents(contentTypes(contents)).map((agent) => agent.id),
        contents,
        counts: contentCounts(contents),
        partial: plugin.selection !== undefined,
      };
    }),
  };
}

/** Stable machine-readable shape for `adg plugins status --json`. */
export function pluginsStatusJson(
  statuses: AgentStatus[],
  pluginsDir: string,
  scope: AgentScope,
  targets: AdapterTarget[],
): PluginsStatusJson {
  return { pluginsDir, scope, targets, statuses };
}

export function printJson(value: PluginsListJson | PluginsStatusJson): void {
  console.log(JSON.stringify(value, null, 2));
}
