/**
 * Non-blocking update check for the ADG CLI.
 *
 * On every invocation we read a local cache file to decide whether to show an
 * "update available" notice. When the cache is stale (older than 24 h) we
 * schedule a background HTTP request — using an unreffed socket so it cannot
 * block the process from exiting — that refreshes the cache for the *next* run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, prereleaseChannel } from "./semver.ts";

const PACKAGE_NAME = "@rbbtsn0w/adg";
// URL-encode the slash in the scoped package name for the npm registry API.
// The abbreviated packument (vnd.npm.install-v1+json) is small and exposes
// `dist-tags`, which we need to follow the caller's release channel (e.g. the
// `beta` dist-tag for pre-release users, not just `latest`).
const REGISTRY_URL = `https://registry.npmjs.org/@rbbtsn0w%2Fadg`;
const REGISTRY_ACCEPT = "application/vnd.npm.install-v1+json";
const CACHE_FILENAME = "update-check.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Cap the accumulated response body. The abbreviated packument is small, but a
// registry that ignores the abbreviated Accept header (or returns an unexpected
// payload) could stream a much larger body; abort rather than grow unbounded.
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

interface UpdateCache {
  latestVersion: string;
  checkedAt: string; // ISO-8601 timestamp
}

/** Resolve the directory that holds the update-check cache file. */
export function updateCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "adg");
}

function cachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(updateCacheDir(env), CACHE_FILENAME);
}

/** Read the on-disk cache, returning null on any error. */
export function readUpdateCache(env: NodeJS.ProcessEnv = process.env): UpdateCache | null {
  try {
    const raw = readFileSync(cachePath(env), "utf8");
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

/** Write the cache, creating the directory if needed. Silently ignores errors. */
export function writeUpdateCache(cache: UpdateCache, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = updateCacheDir(env);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(env), JSON.stringify(cache), "utf8");
  } catch {
    // Ignore write errors (read-only FS, permissions, etc.)
  }
}

/**
 * Pick the newest version relevant to the caller's release channel from the
 * registry's `dist-tags`.
 *
 * Always considers `latest` (stable). When `currentVersion` is a pre-release
 * (e.g. `0.3.0-beta.2`) it also considers the matching channel tag (e.g.
 * `beta`), so pre-release users are notified of newer pre-releases as well as a
 * newer stable. Returns the max candidate by pre-release-aware comparison, or
 * `undefined` when no usable tag is present.
 */
export function resolveLatestForChannel(
  currentVersion: string,
  distTags: Record<string, string> | undefined,
): string | undefined {
  if (!distTags) return undefined;
  const candidates: string[] = [];
  if (typeof distTags.latest === "string") candidates.push(distTags.latest);
  const channel = prereleaseChannel(currentVersion);
  if (channel && typeof distTags[channel] === "string") candidates.push(distTags[channel]!);
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

/**
 * Fire-and-forget background fetch of the latest version from the npm registry.
 * The socket is unreffed so Node can exit naturally without waiting for the
 * request to complete — the cache will be refreshed on the *next* run.
 */
export function scheduleUpdateCacheRefresh(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const req = https.get(
      REGISTRY_URL,
      { headers: { "User-Agent": `adg/${currentVersion}`, Accept: REGISTRY_ACCEPT } },
      (res) => {
        // Decode as UTF-8 at the stream level so multi-byte characters split
        // across chunk boundaries are reassembled correctly (raw Buffers would
        // corrupt them).
        res.setEncoding("utf8");
        let body = "";
        let byteCount = 0;
        res.on("data", (chunk: string) => {
          byteCount += Buffer.byteLength(chunk, "utf8");
          if (byteCount > MAX_RESPONSE_BYTES) {
            // Oversized payload: stop reading and abort so we neither buffer
            // unbounded memory nor parse a partial body.
            body = "";
            req.destroy();
            return;
          }
          body += chunk;
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(body) as { "dist-tags"?: Record<string, string> };
            const latestVersion = resolveLatestForChannel(currentVersion, data["dist-tags"]);
            if (latestVersion !== undefined) {
              writeUpdateCache({ latestVersion, checkedAt: new Date().toISOString() }, env);
            }
          } catch {
            // Ignore parse errors
          }
        });
        res.resume(); // drain the response so the socket is released
      },
    );
    // Destroy the request after 5 s to avoid a long-running socket that
    // could delay the next run's check (not the current run — the socket is
    // unreffed so the process exits freely).
    req.setTimeout(5000, () => req.destroy());
    req.on("error", () => {}); // Ignore network errors
    // Unref as soon as the underlying socket is assigned so the request does
    // not keep the event loop alive after the command finishes.
    req.on("socket", (socket) => socket.unref());
  } catch {
    // If https.get itself throws, ignore it silently.
  }
}

/**
 * Check whether an update is available and print a notice if so.
 *
 * Reads the local cache synchronously (fast, no network) and, when the cache
 * is stale, schedules a background refresh for the next invocation.
 *
 * @param currentVersion  The version string from package.json (e.g. "0.1.1").
 * @returns The newer version string if an update is available, otherwise undefined.
 */
export function checkForUpdate(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  refresh: (currentVersion: string, env: NodeJS.ProcessEnv) => void = scheduleUpdateCacheRefresh,
): string | undefined {
  const cache = readUpdateCache(env);
  const now = Date.now();
  const checkedAt = cache ? new Date(cache.checkedAt).getTime() : 0;
  const checkedAtMs = Number.isFinite(checkedAt) ? checkedAt : 0;
  const isStale = !cache || now - checkedAtMs > CACHE_TTL_MS;

  if (isStale) {
    refresh(currentVersion, env);
  }

  if (!cache) return undefined;

  try {
    return compareVersions(cache.latestVersion, currentVersion) > 0 ? cache.latestVersion : undefined;
  } catch {
    return undefined;
  }
}

/** Format an update notice for display on stderr. */
export function formatUpdateNotice(currentVersion: string, latestVersion: string): string {
  // A pre-release suggestion lives on its channel dist-tag (e.g. `beta`), not
  // `latest`; installing `@latest` would pull the stable release instead of the
  // advertised version. Pin to the exact version so the right artifact installs.
  const channel = prereleaseChannel(latestVersion);
  const installTarget = channel ? latestVersion : "latest";
  return (
    `\n  Update available: ${currentVersion} → ${latestVersion}\n` +
    `  Run: npm install -g ${PACKAGE_NAME}@${installTarget}\n`
  );
}
