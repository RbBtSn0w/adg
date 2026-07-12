import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { folderHash } from "./hash.ts";
import { readManifest } from "./manifest.ts";
import { withPluginSourceCache } from "./materialize.ts";
import { PROJECTION_DIRS, packageFilter } from "./package.ts";
import { legacyPluginSourceCacheDir, pluginSourceCacheDir } from "./paths.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import { runGit } from "./sources.ts";
import type { LockEntry } from "./types.ts";

class SourceCacheIntegrityError extends Error {}

function sourceHash(dir: string): string {
  const manifest = readManifest(dir);
  return folderHash(dir, PROJECTION_DIRS, packageFilter(manifest, { includeProjections: false }));
}

function assertSourceHash(dir: string, name: string, expected: string): void {
  if (sourceHash(dir) !== expected) {
    recordTelemetryEvent("adg.cache.recovery", { outcome: "hash_mismatch" });
    throw new SourceCacheIntegrityError(`source cache integrity mismatch for "${name}"; run \`adg plugins update\` or re-add the plugin`);
  }
}

function recordRecoveryFailure(error: unknown): void {
  if (!(error instanceof SourceCacheIntegrityError)) {
    recordTelemetryEvent("adg.cache.recovery", { outcome: "missing_unrecoverable" });
  }
}

function remoteUrl(entry: LockEntry): string | undefined {
  if (entry.origin.type === "github") return `https://github.com/${entry.origin.repo}.git`;
  if (entry.origin.type === "git") return entry.origin.url;
  return undefined;
}

function restoreExactRemoteSnapshot(pluginsDir: string, name: string, entry: LockEntry): string | undefined {
  const url = remoteUrl(entry);
  if (!url || !entry.resolvedRevision) return undefined;
  const temp = mkdtempSync(join(tmpdir(), "adg-cache-restore-"));
  try {
    // Do not check out origin/ref: it is user update intent and can move. Fetch
    // only the exact commit persisted by the v4 lock instead.
    runGit(["-C", temp, "init"]);
    runGit(["-C", temp, "remote", "add", "origin", url]);
    runGit(["-C", temp, "fetch", "--depth", "1", "origin", entry.resolvedRevision]);
    runGit(["-C", temp, "checkout", "--detach", "FETCH_HEAD"]);
    const source = resolve(temp, entry.origin.path || ".");
    const rel = relative(temp, source);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`locked source path escapes the repository for "${name}"`);
    }
    if (!existsSync(source)) throw new Error(`locked source path is missing for "${name}"`);
    assertSourceHash(source, name, entry.sourceHash);
    const manifest = readManifest(source);
    return withPluginSourceCache(source, pluginSourceCacheDir(pluginsDir, name), manifest, (snapshot) => {
      assertSourceHash(snapshot, name, entry.sourceHash);
      return snapshot;
    });
  } catch (error) {
    recordRecoveryFailure(error);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot restore "${name}" at locked revision ${entry.resolvedRevision}: ${message}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Return a complete source payload for rematerialization. The modern cache is
 * authoritative; a legacy snapshot is adopted only after proving it matches
 * the lock hash. Local origins are likewise accepted only when they still
 * reproduce the locked source hash. Remote entries intentionally never fall
 * back to their moving ref: a missing immutable snapshot is a hard recovery
 * failure until an explicit update/add records a new revision.
 */
export function resolvePluginSourceSnapshot(pluginsDir: string, name: string, entry: LockEntry): string {
  if (!entry || typeof entry !== "object" || !entry.origin || typeof entry.origin !== "object") {
    throw new Error(`Invalid or missing lock entry for "${name}"`);
  }
  const cache = pluginSourceCacheDir(pluginsDir, name);
  if (existsSync(cache)) {
    assertSourceHash(cache, name, entry.sourceHash);
    recordTelemetryEvent("adg.cache.recovery", { outcome: "hit" });
    return cache;
  }

  const legacy = legacyPluginSourceCacheDir(pluginsDir, name);
  if (existsSync(legacy)) {
    try {
      assertSourceHash(legacy, name, entry.sourceHash);
      const manifest = readManifest(legacy);
      const adopted = withPluginSourceCache(legacy, cache, manifest, (snapshot) => {
        assertSourceHash(snapshot, name, entry.sourceHash);
        return snapshot;
      });
      recordTelemetryEvent("adg.cache.recovery", { outcome: "adopted_legacy" });
      return adopted;
    } catch (error) {
      recordRecoveryFailure(error);
      throw error;
    }
  }

  if (entry.origin.type === "local") {
    const local = resolve(pluginsDir, entry.origin.path);
    if (existsSync(local)) {
      try {
        assertSourceHash(local, name, entry.sourceHash);
        const manifest = readManifest(local);
        const restored = withPluginSourceCache(local, cache, manifest, (snapshot) => {
          assertSourceHash(snapshot, name, entry.sourceHash);
          return snapshot;
        });
        recordTelemetryEvent("adg.cache.recovery", { outcome: "restored_local" });
        return restored;
      } catch (error) {
        recordRecoveryFailure(error);
        throw error;
      }
    }
  }

  const restored = restoreExactRemoteSnapshot(pluginsDir, name, entry);
  if (restored) {
    recordTelemetryEvent("adg.cache.recovery", { outcome: "restored_remote" });
    return restored;
  }

  recordTelemetryEvent("adg.cache.recovery", { outcome: "missing_unrecoverable" });
  const legacyHint = entry.origin.type === "github" || entry.origin.type === "git"
    ? "Remote source recovery requires an immutable revision; run `adg plugins update` or re-add the plugin."
    : "Run `adg plugins update` or re-add the plugin.";
  throw new Error(`source cache missing for "${name}". ${legacyHint}`);
}
