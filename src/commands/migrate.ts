import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Span } from "@opentelemetry/api";
import { ADAPTER_TARGETS } from "../adapters/index.ts";
import { folderHash } from "../hash.ts";
import { readManifest } from "../manifest.ts";
import { effectivePackageFilter, materializePlugin, withPluginSourceCache } from "../materialize.ts";
import { packageFilter, PROJECTION_DIRS } from "../package.ts";
import { installedPluginDir, lockPath, marketplacePath, marketplaceSourcePath, pluginDir, pluginSourceCacheDir } from "../paths.ts";
import { readLock, writeLock } from "../lock.ts";
import { readMarketplace, upsertMarketplacePlugin, writeMarketplace } from "../marketplace.ts";
import { adaptPlugin } from "./adapt.ts";
import { recordTelemetryEvent } from "../telemetry.ts";
import { LOCK_VERSION, normalizePluginSelection, resolveSelectionDependencies, type LockEntry, type PluginLock, type PluginSelection, type PluginSource, type PluginState } from "../types.ts";

export interface MigrateMove {
  name: string;
  from: string;
  to: string;
}

export interface MigrateResult {
  /** True when a legacy v2 lock was upgraded to the current format. */
  lockUpgraded: boolean;
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
export function migrateLayout(pluginsDir: string, telemetrySpan?: Pick<Span, "addEvent">): MigrateResult {
  const lockUpgraded = migrateLock(pluginsDir, telemetrySpan);
  const lock = readLock(lockPath(pluginsDir), telemetrySpan);
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
  return { lockUpgraded, moved, unchanged, missing };
}

interface LockEntryV2 {
  origin: PluginSource;
  version: string;
  folderHash: string;
  installedAt: string;
  updatedAt: string;
  dependencies?: Record<string, string>;
  selection?: PluginSelection;
  state?: PluginState;
}

interface PluginLockV2 {
  version: 2;
  plugins: Record<string, LockEntryV2>;
  lastSelected?: string[];
}

/**
 * Explicitly upgrade a v2 store. The old full installation is cached before
 * selection-aware materialization, so unselected payload remains recoverable.
 * The v3 lock is written only after every plugin has been converted.
 */
function migrateLock(pluginsDir: string, telemetrySpan?: Pick<Span, "addEvent">): boolean {
  const file = lockPath(pluginsDir);
  if (!existsSync(file)) return false;
  const raw = JSON.parse(readFileSync(file, "utf8")) as PluginLockV2 | PluginLock;
  if (!raw || typeof raw !== "object") throw new Error(`${file} is not a valid lock file`);
  if (raw.version === LOCK_VERSION) return false;
  if (typeof raw?.version === "number") {
    recordTelemetryEvent("adg.lock.read", { "format.version": raw.version === 2 || raw.version === 3 || raw.version === 4 ? raw.version : -1 }, telemetrySpan);
  }
  if ((raw.version === 3 || raw.version === 4) && typeof raw.plugins === "object" && raw.plugins !== null) {
    // v3 has the same payload model; v4 adds optional immutable provenance.
    // Existing remote entries remain explicitly legacy until an update/add
    // resolves their commit, rather than inventing a moving ref as a revision.
    writeLock(file, { ...raw, version: LOCK_VERSION });
    recordTelemetryEvent("adg.lock.migrate", { "from.version": raw.version, "to.version": LOCK_VERSION }, telemetrySpan);
    return true;
  }
  if (raw.version !== 2 || typeof raw.plugins !== "object" || raw.plugins === null) {
    throw new Error(`${file} uses unsupported lock version ${raw.version}; expected ${LOCK_VERSION}`);
  }

  const plugins: Record<string, LockEntry> = {};
  for (const [name, oldEntry] of Object.entries(raw.plugins)) {
    const installed = installedPluginDir(pluginsDir, name, oldEntry.origin);
    const cache = pluginSourceCacheDir(pluginsDir, name);
    const source = existsSync(cache) ? cache : installed;
    if (!existsSync(source)) throw new Error(`cannot migrate "${name}": installed directory and source cache are missing`);
    const manifest = readManifest(source, telemetrySpan);
    const desiredSelection = normalizePluginSelection(oldEntry.selection);
    const selection = resolveSelectionDependencies(manifest, desiredSelection);

    withPluginSourceCache(source, cache, manifest, (snapshot) => {
      const sourceHash = folderHash(snapshot, PROJECTION_DIRS, packageFilter(manifest, { includeProjections: false }));
      let installedHash = "";
      materializePlugin({
        source: snapshot,
        destination: installed,
        manifest,
        selection,
        build: (staging) => {
          adaptPlugin(staging, [...ADAPTER_TARGETS], selection);
          installedHash = folderHash(staging, PROJECTION_DIRS, effectivePackageFilter(manifest, selection));
        },
      });
      plugins[name] = {
        origin: oldEntry.origin,
        version: oldEntry.version,
        sourceHash,
        installedHash,
        installedAt: oldEntry.installedAt,
        updatedAt: oldEntry.updatedAt,
        ...(oldEntry.dependencies ? { dependencies: oldEntry.dependencies } : {}),
        ...(desiredSelection ? { selection: desiredSelection } : {}),
        ...(oldEntry.state ? { state: oldEntry.state } : {}),
      };
    });
  }

  writeLock(file, { version: LOCK_VERSION, plugins, ...(raw.lastSelected ? { lastSelected: raw.lastSelected } : {}) });
  recordTelemetryEvent(
    "adg.lock.migrate",
    { "from.version": 2, "to.version": LOCK_VERSION },
    telemetrySpan,
  );
  return true;
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
