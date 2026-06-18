import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockPath, marketplacePath, marketplaceSourcePath, pluginDir } from "../paths.ts";
import { readLock } from "../lock.ts";
import { readMarketplace, upsertMarketplacePlugin, writeMarketplace } from "../marketplace.ts";

export interface MigrateMove {
  name: string;
  from: string;
  to: string;
}

export interface MigrateResult {
  /** Plugin directories relocated into their per-marketplace bucket. */
  moved: MigrateMove[];
  /** Already in the right place (or local/flat) — left untouched. */
  unchanged: string[];
  /** In the lock but no directory found at either the old or new path. */
  missing: string[];
}

/**
 * Migrate a flat plugins directory to the per-marketplace nested layout.
 *
 * For every locked plugin, move `<pluginsDir>/<name>` to the origin-derived
 * `<pluginsDir>/<segment>/<name>` (remote sources only; local installs stay
 * flat) and rewrite its marketplace.json `source.path` to match. Idempotent:
 * plugins already at their target path are reported as unchanged.
 */
export function migrateLayout(pluginsDir: string): MigrateResult {
  const lock = readLock(lockPath(pluginsDir));
  const moved: MigrateMove[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];

  const marketFile = marketplacePath(pluginsDir);
  const market = readMarketplace(marketFile, "");
  let marketDirty = false;

  for (const [name, entry] of Object.entries(lock.plugins)) {
    const flat = join(pluginsDir, name);
    const target = pluginDir(pluginsDir, name, entry.origin);

    if (target === flat) {
      unchanged.push(name);
      continue;
    }

    if (existsSync(target)) {
      // Already migrated; nothing to move, but make sure the export agrees.
      if (rewriteMarketplacePath(market, name, pluginsDir, target)) marketDirty = true;
      unchanged.push(name);
      continue;
    }

    if (!existsSync(flat)) {
      missing.push(name);
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    renameSync(flat, target);
    if (rewriteMarketplacePath(market, name, pluginsDir, target)) marketDirty = true;
    moved.push({ name, from: flat, to: target });
  }

  if (marketDirty) writeMarketplace(marketFile, market);
  return { moved, unchanged, missing };
}

/** Point a marketplace entry's `source.path` at the plugin's on-disk dir. */
function rewriteMarketplacePath(
  market: ReturnType<typeof readMarketplace>,
  name: string,
  pluginsDir: string,
  dir: string,
): boolean {
  const existing = market.plugins.find((p) => p.name === name);
  if (!existing) return false;
  const path = marketplaceSourcePath(pluginsDir, dir);
  if (existing.source.path === path) return false;
  upsertMarketplacePlugin(market, { ...existing, source: { ...existing.source, path } });
  return true;
}
