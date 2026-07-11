import { resolve } from "node:path";
import { codexMarketplaceRoot } from "./paths.ts";

export type CodexMarketplaceConfig = {
  marketplaces: Map<string, string>;
  plugins: Array<{ name: string; marketplace: string; enabled: boolean }>;
};

export type CodexMarketplaceMigrationPlan = {
  legacyMarketplaces: string[];
  legacyPluginCount: number;
  orphanPluginCount: number;
  commands: string[][];
};

export type CodexMarketplaceMigrationOutcome = "none" | "completed" | "deferred" | "partial" | "config_unavailable";

export type CodexMarketplaceMigrationResult = {
  outcome: CodexMarketplaceMigrationOutcome;
  removedPluginCount: number;
  removedMarketplaceCount: number;
};

type CodexRunResult = { ok: boolean; out: string };

export type CodexMarketplaceMigrationOptions = {
  pluginsDir: string;
  marketplace: string;
  /** Only plugins whose canonical install succeeded in this link/sync pass. */
  plugins: string[];
  readConfig: () => string;
  run: (command: string[]) => CodexRunResult;
  report: (attributes: Record<string, string | number>) => void;
};

/**
 * Read only the marketplace/plugin tables that this migrator owns. Codex keeps
 * these values as simple TOML scalars, so a narrow parser avoids adding a TOML
 * dependency to ADG's runtime just for a one-shot cleanup utility.
 */
export function parseCodexPluginConfig(toml: string): CodexMarketplaceConfig {
  const marketplaces = new Map<string, string>();
  const plugins: Array<{ name: string; marketplace: string; enabled: boolean }> = [];
  let marketplace: string | undefined;
  let plugin: { name: string; marketplace: string; enabled: boolean } | undefined;

  const flushPlugin = () => {
    if (plugin) plugins.push(plugin);
    plugin = undefined;
  };

  for (const line of toml.split("\n")) {
    const marketplaceHeader = line.match(/^\s*\[marketplaces\.([A-Za-z0-9_-]+)\]\s*$/u);
    const pluginHeader = line.match(/^\s*\[plugins\."([^"@]+)@([^"@]+)"\]\s*$/u);
    if (marketplaceHeader || pluginHeader || /^\s*\[/u.test(line)) {
      flushPlugin();
      marketplace = marketplaceHeader?.[1];
      if (pluginHeader) plugin = { name: pluginHeader[1]!, marketplace: pluginHeader[2]!, enabled: false };
      continue;
    }

    if (marketplace) {
      const source = line.match(/^\s*source\s*=\s*"([^"]+)"\s*$/u);
      if (source) marketplaces.set(marketplace, source[1]!);
    }
    if (plugin && /^\s*enabled\s*=\s*true\s*$/u.test(line)) plugin.enabled = true;
  }
  flushPlugin();
  return { marketplaces, plugins };
}

/**
 * Build an idempotent cleanup sequence for plugins whose canonical identity was
 * successfully installed during this link/sync pass.
 */
export function planCodexMarketplaceCleanup(
  config: CodexMarketplaceConfig,
  canonicalRoot: string,
  canonicalMarketplace: string,
  pluginNames: string[],
): CodexMarketplaceMigrationPlan {
  const root = resolve(canonicalRoot);
  const legacyMarketplaces = [...config.marketplaces]
    .filter(([name, source]) => name !== canonicalMarketplace && resolve(source) === root)
    .map(([name]) => name)
    .sort();
  const legacySet = new Set(legacyMarketplaces);
  const selected = new Set(pluginNames);
  const legacyPlugins = config.plugins.filter((plugin) => legacySet.has(plugin.marketplace));
  const commands: string[][] = [];

  for (const plugin of legacyPlugins) {
    if (!selected.has(plugin.name)) continue;
    commands.push(["plugin", "remove", `${plugin.name}@${plugin.marketplace}`]);
  }
  for (const marketplace of legacyMarketplaces) {
    const residual = legacyPlugins.some((plugin) => plugin.marketplace === marketplace && !selected.has(plugin.name));
    if (!residual) commands.push(["plugin", "marketplace", "remove", marketplace]);
  }

  // Old Codex versions can leave plugin entries behind after their marketplace
  // registration was removed. Delete only an orphan selected by this successful
  // pass; a different live marketplace is intentionally left alone even if it
  // happens to use the same plugin name.
  const configuredMarketplaces = new Set(config.marketplaces.keys());
  const orphaned = config.plugins
    .filter((plugin) => plugin.marketplace !== canonicalMarketplace)
    .filter((plugin) => !configuredMarketplaces.has(plugin.marketplace))
    .filter((plugin) => selected.has(plugin.name))
    .sort((a, b) => `${a.name}@${a.marketplace}`.localeCompare(`${b.name}@${b.marketplace}`));
  for (const plugin of orphaned) {
    commands.push(["plugin", "remove", `${plugin.name}@${plugin.marketplace}`]);
  }
  return { legacyMarketplaces, legacyPluginCount: legacyPlugins.length, orphanPluginCount: orphaned.length, commands };
}

/**
 * Remove legacy Codex plugin identities only after this run has successfully
 * installed their canonical replacements. A failed deletion leaves the legacy
 * marketplace in place, so cleanup cannot make the remaining identities
 * undiscoverable.
 */
export function reconcileCodexMarketplaceAliases(opts: CodexMarketplaceMigrationOptions): CodexMarketplaceMigrationResult {
  let config: CodexMarketplaceConfig;
  try {
    config = parseCodexPluginConfig(opts.readConfig());
  } catch {
    const result = { outcome: "config_unavailable" as const, removedPluginCount: 0, removedMarketplaceCount: 0 };
    opts.report({
      "legacy.marketplace_count": 0,
      "legacy.plugin_count": 0,
      "legacy.orphan_plugin_count": 0,
      "migration.removed_plugin_count": 0,
      "migration.removed_marketplace_count": 0,
      "migration.outcome": result.outcome,
    });
    return result;
  }

  const plan = planCodexMarketplaceCleanup(config, codexMarketplaceRoot(opts.pluginsDir), opts.marketplace, opts.plugins);
  const pluginCommands = plan.commands.filter((command) => command[1] !== "marketplace");
  const marketplaceCommands = plan.commands.filter((command) => command[1] === "marketplace");
  let removedPluginCount = 0;
  let removedMarketplaceCount = 0;
  let failed = false;

  for (const command of pluginCommands) {
    if (opts.run(command).ok) removedPluginCount += 1;
    else failed = true;
  }
  if (!failed) {
    for (const command of marketplaceCommands) {
      if (opts.run(command).ok) removedMarketplaceCount += 1;
      else failed = true;
    }
  }

  const hasLegacy = plan.legacyPluginCount > 0 || plan.orphanPluginCount > 0;
  const hasDeferredLegacy = plan.legacyMarketplaces.some((marketplace) => !marketplaceCommands.some((command) => command[3] === marketplace));
  const outcome: CodexMarketplaceMigrationOutcome = failed
    ? "partial"
    : !hasLegacy
      ? "none"
      : hasDeferredLegacy
        ? "deferred"
        : "completed";
  opts.report({
    "legacy.marketplace_count": plan.legacyMarketplaces.length,
    "legacy.plugin_count": plan.legacyPluginCount,
    "legacy.orphan_plugin_count": plan.orphanPluginCount,
    "migration.removed_plugin_count": removedPluginCount,
    "migration.removed_marketplace_count": removedMarketplaceCount,
    "migration.outcome": outcome,
  });
  return { outcome, removedPluginCount, removedMarketplaceCount };
}
