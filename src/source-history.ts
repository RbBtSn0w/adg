import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposedContents, pluginContents, presentComponents, type PluginContents } from "./components.ts";
import { folderHash } from "./hash.ts";
import { resolveSkillEntries } from "./skills.ts";
import { readManifest } from "./manifest.ts";
import { effectivePackageFilter } from "./materialize.ts";
import { PROJECTION_DIRS } from "./package.ts";
import { installedPluginDir, pluginSourceCacheDir } from "./paths.ts";
import { materializeSource } from "./remote/client.ts";
import { parseGitHubSource, type GitRunner } from "./sources.ts";
import { resolveSelectionDependencies, type AdgManifest, type LockEntry, type PluginLock, type PluginSelection, type SourceHistoryEntry } from "./types.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import { discoverPlugins } from "./commands/install/discovery.ts";
import { contentHash } from "./commands/install/install-one.ts";
import type { HistoricalPlugin } from "./upgrade-plan.ts";

const SOURCE_CATALOGS = [".agents/.marketplace.json", ".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"];

/** A missing legacy full-selection field cannot establish requested intent. */
export function requestedSelectionKnown(entry: { selectionKnown?: boolean; selection?: PluginSelection }): boolean {
  return entry.selectionKnown === true || (entry.selection !== undefined && entry.selectionKnown !== false);
}

function effectivePresence(contents: PluginContents): PluginSelection {
  return { components: presentComponents(contents),
    ...(contents.skills.length ? { skills: [...contents.skills] } : {}),
    ...(contents.mcp.length ? { mcp: [...contents.mcp] } : {}) };
}

interface VerifiedInventory { manifest: AdgManifest; contents: PluginContents }

function verifiedCache(dir: string, expected: string): VerifiedInventory | undefined {
  try {
    const manifest = readManifest(dir);
    if (contentHash(dir, manifest) !== expected) return undefined;
    return { manifest, contents: pluginContents(dir, manifest) };
  } catch { return undefined; }
}

function hasVisibleFile(path: string): boolean {
  if (!existsSync(path)) return false;
  if (statSync(path).isFile()) return true;
  return readdirSync(path, { withFileTypes: true }).some((entry) => !entry.name.startsWith(".")
    && (entry.isFile() || entry.isDirectory() && hasVisibleFile(join(path, entry.name))));
}

function verifiedInstalled(dir: string, expected: string): VerifiedInventory | undefined {
  try {
    const manifest = readManifest(dir);
    // The materialized manifest already describes the selected payload. Using
    // requested policy here would conceal bytes when that legacy policy is lost.
    if (folderHash(dir, PROJECTION_DIRS, effectivePackageFilter(manifest)) !== expected) return undefined;
    const contents = pluginContents(dir, manifest);
    contents.skills = resolveSkillEntries(dir, manifest)
      .filter((entry) => entry.skillMd && statSync(entry.skillMd).isFile()).map((entry) => entry.name).sort();
    for (const component of ["agents", "commands", "hooks", "apps"] as const) {
      const path = manifest[component];
      if (!path || !hasVisibleFile(join(dir, path))) contents[component] = [];
    }
    return { manifest, contents };
  } catch { return undefined; }
}

/** Rebuilding projections is not permission to broaden an unknown legacy choice. */
export function preservedSelection(store: string, name: string, entry: LockEntry): PluginSelection | undefined {
  if (requestedSelectionKnown(entry)) return entry.selection;
  const installed = verifiedInstalled(installedPluginDir(store, name, entry.origin), entry.installedHash);
  if (!installed) throw new Error(`Cannot verify the installed selection of ${name}; review its selection before rebuilding.`);
  return effectivePresence(installed.contents);
}

/** Verified effective bytes can establish existing permissions when the cache is damaged. */
export function verifiedInstalledPayload(store: string, name: string, entry: LockEntry): string | undefined {
  const dir = installedPluginDir(store, name, entry.origin);
  return verifiedInstalled(dir, entry.installedHash) ? dir : undefined;
}

export function installedHistory(store: string, lock: PluginLock, source: string, ref?: string): SourceHistoryEntry[] {
  return Object.entries(lock.plugins).flatMap(([name, entry]) => {
    if (entry.origin.type !== "github" || entry.origin.repo.toLowerCase() !== source.toLowerCase() || entry.origin.ref !== ref) return [];
    // Source availability and actual installed selection are independent evidence.
    const cached = verifiedCache(pluginSourceCacheDir(store, name), entry.sourceHash);
    const installed = verifiedInstalled(installedPluginDir(store, name, entry.origin), entry.installedHash);
    const selectionKnown = requestedSelectionKnown(entry);
    const evidence = !cached && !installed ? "none" : selectionKnown ? "selection" : installed ? "installed" : "catalog";
    recordTelemetryEvent("adg.update.history.evidence", { "cache.verified": Boolean(cached), "installed.verified": Boolean(installed),
      "selection.known": selectionKnown, "evidence.kind": evidence });
    if (!cached && !installed) return [];
    const inventory = cached ?? installed!;
    return [{ name, version: entry.version, origin: entry.origin, sourceHash: entry.sourceHash,
      contents: inventory.contents,
      ...(selectionKnown && entry.selection !== undefined ? { selection: entry.selection } : {}),
      selectionKnown,
      effectiveSelection: selectionKnown
        ? resolveSelectionDependencies(inventory.manifest, entry.selection)
        : installed ? effectivePresence(installed.contents) : { components: [] },
      state: entry.state,
      evidence: selectionKnown ? "selection" : installed ? "installed" : "catalog" }];
  });
}

/** Read native catalog metadata without adding a publisher-owned control file. */
export function marketplaceRenames(checkout: string): Record<string, string | null> {
  const merged: Record<string, string | null> = {};
  for (const file of SOURCE_CATALOGS) {
    const path = join(checkout, file);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { renames?: unknown };
    if (raw.renames === undefined) continue;
    if (!raw.renames || typeof raw.renames !== "object" || Array.isArray(raw.renames)) throw new Error("Invalid marketplace renames map");
    for (const [name, target] of Object.entries(raw.renames)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || target !== null && (typeof target !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target))) {
        throw new Error("Invalid marketplace rename identity");
      }
      if (Object.hasOwn(merged, name) && merged[name] !== target) throw new Error(`Conflicting marketplace rename: ${name}`);
      merged[name] = target as string | null;
    }
  }
  return merged;
}

/** A published catalog can withdraw a plugin while retaining its source files. */
export function sourceCatalogNames(checkout: string): Set<string> | undefined {
  for (const file of SOURCE_CATALOGS) {
    const path = join(checkout, file);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; plugins?: unknown };
    if (typeof raw.name !== "string" || !Array.isArray(raw.plugins)) throw new Error("Invalid source marketplace catalog");
    const names = raw.plugins.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") throw new Error("Invalid source marketplace entry");
      return entry.name;
    });
    if (new Set(names).size !== names.length) throw new Error("Duplicate source marketplace identity");
    return new Set(names);
  }
  return undefined;
}

/** Recover overwritten legacy inventories from the predecessor's fixed source. */
export async function recoverLegacyHistory(options: {
  source: string; ref?: string; lock: PluginLock; installed: SourceHistoryEntry[];
  currentNames: Set<string>; runner?: GitRunner;
}): Promise<HistoricalPlugin[]> {
  const anchors = options.installed.filter(p => !options.currentNames.has(p.name)
    && options.installed.some(peer => peer.version !== p.version));
  for (const anchor of anchors) {
    const entry = options.lock.plugins[anchor.name]!;
    const ref = entry.resolvedRevision || (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version) ? `v${entry.version}` : undefined);
    if (!ref) continue;
    const checkout = mkdtempSync(join(tmpdir(), "adg-source-history-"));
    try {
      const parsed = parseGitHubSource(options.source);
      await materializeSource({ ...parsed, ref }, checkout, { runner: options.runner,
        ...(entry.resolvedRevision ? { resolvedRevision: entry.resolvedRevision } : {}), timeoutMs: 10_000 });
      const { candidates } = discoverPlugins(checkout);
      const predecessor = candidates.get(anchor.name);
      if (!predecessor || predecessor.manifest.version !== anchor.version || contentHash(predecessor.dir, predecessor.manifest) !== anchor.sourceHash) continue;
      const recovered = options.installed.flatMap(current => {
        const old = candidates.get(current.name);
        if (!old) return [];
        const contents = pluginContents(old.dir, old.manifest);
        const knownPartial = requestedSelectionKnown(current) && current.selection !== undefined;
        const bound = knownPartial ? current.effectiveSelection ?? current.selection
          : current.evidence === "installed" ? current.effectiveSelection : undefined;
        return [{ name: current.name, origin: current.origin, version: old.manifest.version,
          sourceHash: contentHash(old.dir, old.manifest), contents,
          ...(knownPartial ? { selection: current.selection } : {}), selectionKnown: knownPartial,
          effectiveSelection: bound ? effectivePresence(exposedContents(contents, bound)) : { components: [] },
          // The old release proves availability. It cannot establish which of
          // those historical capabilities this user ever requested or installed.
          state: current.state, evidence: "catalog" as const, uncertain: true }];
      });
      recordTelemetryEvent("adg.update.history.recovered", { "plugins.count": recovered.length });
      return recovered;
    } catch { recordTelemetryEvent("adg.update.history.unavailable", { "history.available": false }); }
    finally { rmSync(checkout, { recursive: true, force: true }); }
  }
  return [];
}
