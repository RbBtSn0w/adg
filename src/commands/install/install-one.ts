import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ADAPTER_TARGETS } from "../../adapters/index.ts";
import { adaptPlugin } from "../adapt.ts";
import { folderHash } from "../../hash.ts";
import { packageFilter, PROJECTION_DIRS } from "../../package.ts";
import { lockPath, marketplacePath, marketplaceSourcePath, pluginDir, pluginSourceCacheDir } from "../../paths.ts";
import { readLock, upsertEntry, writeLock } from "../../lock.ts";
import { readManifest } from "../../manifest.ts";
import { recordTelemetryEvent } from "../../telemetry.ts";
import { readMarketplace, upsertMarketplacePlugin, writeMarketplace } from "../../marketplace.ts";
import {
  normalizePluginSelection,
  COMPONENT_TYPES,
  resolveSelectionDependencies,
  sameSource,
  type AdgManifest,
  type LockEntry,
  type PluginSource,
} from "../../types.ts";
import { pluginContents } from "../../components.ts";
import { effectivePackageFilter, materializePlugin, withPluginSourceCache } from "../../materialize.ts";
import type { InstallOneOptions, InstallResult } from "./types.ts";
import { pluginComparisonHash, type PluginChanges } from "../../plugin-changes.ts";

// Generated runtime projections never count toward a plugin's content hash.
const HASH_IGNORE = PROJECTION_DIRS;

/** Content hash over a plugin's packaged payload (hooks files are authored content, not generated). */
export function contentHash(dir: string, manifest: AdgManifest): string {
  return folderHash(dir, HASH_IGNORE, packageFilter(manifest, { includeProjections: false }));
}

function describe(s: PluginSource): string {
  switch (s.type) {
    case "local": return `local:${s.path}`;
    case "github": return `github:${s.repo}${s.path ? `/${s.path}` : ""}`;
    case "git": return `git:${s.url}${s.path ? `/${s.path}` : ""}`;
  }
}

/**
 * Install a single local plugin directory into a plugins directory: copy the
 * source, generate adapter manifests, compute the folder hash, and update both
 * .plugin-lock.json and marketplace.json (with denormalized discovery metadata
 * and an integrity digest).
 *
 * Refuses to overwrite a same-named plugin that came from a different upstream
 * source (cross-marketplace name collision). Only files under `pluginsDir` are
 * written — sibling files such as AGENTS.md or a global skills/ are untouched.
 */
export function installPlugin(opts: InstallOneOptions): InstallResult {
  const source = resolve(opts.source);
  const manifest = readManifest(source, opts.telemetrySpan);
  const name = manifest.name;
  // Local installs stay flat; remote sources derive a per-marketplace dir from
  // their origin. The default (no origin) is a flat local copy-in.
  const origin: PluginSource =
    opts.origin ?? { type: "local", path: source };
  const dest = pluginDir(opts.pluginsDir, name, origin);

  const lockFile = lockPath(opts.pluginsDir);
  const lock = readLock(lockFile);
  const prev = lock.plugins[name];
  if (prev && !sameSource(prev.origin, origin)) {
    throw new Error(
      `name collision: "${name}" is already installed from a different source ` +
        `(${describe(prev.origin)} vs ${describe(origin)}). Rename one to avoid the conflict.`,
    );
  }

  // A new selection wins; otherwise keep whatever a prior install recorded so
  // partial installs survive re-install / `marketplace upgrade`.
  const desiredSelection = normalizePluginSelection(opts.selection ?? prev?.selection);
  const selection = resolveSelectionDependencies(manifest, desiredSelection);

  if (selection) {
    const contents = pluginContents(source, manifest);
    if (selection.skills) {
      const invalid = selection.skills.filter((s) => !contents.skills.includes(s));
      if (invalid.length > 0) {
        throw new Error(`selected skill(s) not declared: ${invalid.join(", ")}`);
      }
    }
    if (selection.mcp) {
      const invalid = selection.mcp.filter((s) => !contents.mcp.includes(s));
      if (invalid.length > 0) {
        throw new Error(`selected mcp server(s) not declared: ${invalid.join(", ")}`);
      }
    }

    recordTelemetryEvent("adg.install.selection", {
      plugin: name,
      "components.count": selection.components.length,
      "skills.count": selection.skills ? selection.skills.length : -1,
      "mcp.count": selection.mcp ? selection.mcp.length : -1,
    }, opts.telemetrySpan);
  }

  const sourceHash = contentHash(source, manifest);
  const cacheDir = pluginSourceCacheDir(opts.pluginsDir, name);
  const targets = opts.targets ?? [...ADAPTER_TARGETS];
  const contents = pluginContents(source, manifest);
  const selectedContents = (value: typeof selection) => Object.fromEntries(COMPONENT_TYPES.map((component) => {
    const available = contents[component];
    const selected = component === "skills" ? value?.skills : component === "mcp" ? value?.mcp : undefined;
    return [component, value && !value.components.includes(component) ? [] : available.filter((name) => !selected || selected.includes(name)).sort()];
  }));
  const effectiveSelectionChanged = !isDeepStrictEqual(selectedContents(resolveSelectionDependencies(manifest, prev?.selection)), selectedContents(selection));
  const changes: PluginChanges = {
    version: !prev || prev.version !== manifest.version,
    content: true,
    selection: !isDeepStrictEqual(prev?.selection, desiredSelection),
    source: Boolean(prev && opts.resolvedRevision && prev.resolvedRevision !== opts.resolvedRevision),
  };
  // Capture comparison evidence before the cache transaction replaces it.
  if (prev && existsSync(cacheDir)) {
    try {
      const priorManifest = readManifest(cacheDir);
      if (contentHash(cacheDir, priorManifest) === prev.sourceHash) {
        changes.content = pluginComparisonHash(cacheDir, priorManifest) !== pluginComparisonHash(source, manifest);
      }
    } catch { /* Missing/invalid comparison evidence requires a conservative update. */ }
  }
  let projectionsIntact = false;
  let installationIntact = false;
  try {
    const installedManifest = readManifest(dest);
    const previousSelection = resolveSelectionDependencies(installedManifest, prev?.selection);
    installationIntact = Boolean(prev && folderHash(dest, PROJECTION_DIRS, effectivePackageFilter(installedManifest, previousSelection)) === prev.installedHash);
    // Generate the complete expected installation, including auxiliary MCP,
    // hooks and runner files that are outside native manifest directories.
    const work = mkdtempSync(join(tmpdir(), "adg-projection-check-"));
    try {
      const expected = join(work, "expected");
      materializePlugin({ source: dest, destination: expected, manifest: installedManifest, selection: previousSelection,
        build: (staging) => { adaptPlugin(staging, targets, previousSelection, dest); } });
      const paths = new Set<string>();
      const collect = (dir: string, prefix = "") => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          paths.add(path);
          if (entry.isDirectory()) collect(join(dir, entry.name), path);
        }
      };
      collect(expected);
      projectionsIntact = folderHash(expected) === folderHash(dest, [], (path) => paths.has(path));
    } finally { rmSync(work, { recursive: true, force: true }); }
  } catch { /* Missing or damaged projections must be regenerated. */ }
  return withPluginSourceCache(source, cacheDir, manifest, (snapshot) => {
    // Detect-then-update compares the complete source snapshot, never the
    // selection-pruned runtime installation.
    if (!opts.forceMaterialize && opts.skipUnchanged && prev
      && !effectiveSelectionChanged && projectionsIntact
      && prev.sourceHash === sourceHash && prev.version === manifest.version) {
      const installedIntact = existsSync(dest)
        && folderHash(dest, PROJECTION_DIRS, effectivePackageFilter(manifest, selection)) === prev.installedHash;
      if (installedIntact) {
        if (changes.source || changes.selection) {
          // Exact bytes are verified at this revision; this is not an install.
          lock.plugins[name] = {
            ...prev,
            ...(changes.source ? { resolvedRevision: opts.resolvedRevision! } : {}),
            ...(desiredSelection ? { selection: desiredSelection } : {}),
          };
          writeLock(lockFile, lock);
        }
        recordTelemetryEvent("adg.install.change", { ...changes, "runtime.refresh_required": false }, opts.telemetrySpan);
        return {
          name,
          version: manifest.version,
          installedTo: dest,
          sourceHash,
          installedHash: prev.installedHash,
          adapted: [],
          changed: false,
          changes,
          runtimeRefreshRequired: false,
        };
      }
    }

    const adapted: string[] = [];
    let installedHash = "";
    materializePlugin({
      source: snapshot,
      destination: dest,
      manifest,
      selection,
      build: (staging) => {
        adapted.push(...adaptPlugin(staging, targets, selection, dest).map((r) => relative(staging, r.file)));
        installedHash = folderHash(staging, PROJECTION_DIRS, effectivePackageFilter(manifest, selection));
      },
    });
    const adaptedFiles = adapted.map((file) => join(dest, file));
    const entry: Omit<LockEntry, "installedAt" | "updatedAt"> = {
      origin,
      version: manifest.version,
      sourceHash,
      installedHash,
      ...(opts.resolvedRevision ? { resolvedRevision: opts.resolvedRevision } : {}),
    };
    if (manifest.dependencies?.length) {
      entry.dependencies = Object.fromEntries(manifest.dependencies.map((d) => [d.name, d.version]));
    }
    if (desiredSelection) entry.selection = desiredSelection;
    if (prev?.state) entry.state = prev.state;
    if (opts.definition) entry.definition = opts.definition;
    const previousEntry = prev && Object.fromEntries(
      Object.entries(prev).filter(([key]) => key !== "installedAt" && key !== "updatedAt"),
    );
    const changed = !prev || !isDeepStrictEqual(previousEntry, entry);
    if (changed) {
      upsertEntry(lock, name, entry, opts.now);
      writeLock(lockFile, lock);
    }

    const marketFile = marketplacePath(opts.pluginsDir);
    const fallbackName = opts.marketplaceName ?? basename(opts.pluginsDir);
    const market = readMarketplace(marketFile, fallbackName);
    upsertMarketplacePlugin(market, {
      name,
      source: { source: "local", path: marketplaceSourcePath(opts.pluginsDir, dest) },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      ...(manifest.category ? { category: manifest.category } : {}),
    });
    writeMarketplace(marketFile, market);

    const runtimeRefreshRequired = !prev || changes.version || changes.selection || !projectionsIntact || !installationIntact
      || prev.installedHash !== installedHash || Boolean(opts.forceMaterialize);
    recordTelemetryEvent("adg.install.change", { ...changes, "runtime.refresh_required": runtimeRefreshRequired }, opts.telemetrySpan);
    return { name, version: manifest.version, installedTo: dest, sourceHash, installedHash, adapted: adaptedFiles, changed, changes, runtimeRefreshRequired };
  });
}
