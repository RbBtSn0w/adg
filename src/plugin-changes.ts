import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { folderHash } from "./hash.ts";
import { findManifestFile } from "./manifest.ts";
import { packageFilter, PROJECTION_DIRS } from "./package.ts";
import type { AdgManifest } from "./types.ts";

/** Independent observations, not claims that a running agent loaded the update. */
export interface PluginChanges {
  version: boolean;
  content: boolean;
  selection: boolean;
  source: boolean;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** Comparison only: never replaces exact source/installation integrity digests. */
export function pluginComparisonHash(dir: string, manifest: AdgManifest): string {
  const file = findManifestFile(dir);
  const manifestPath = file && relative(dir, file).replaceAll("\\", "/");
  const include = packageFilter(manifest, { includeProjections: false });
  const payload = folderHash(dir, PROJECTION_DIRS, (path) => path !== manifestPath && include(path));
  // Preserve authored and inherited fields. Only the top-level version is omitted.
  const raw = file ? JSON.parse(readFileSync(file, "utf8")) : manifest;
  const { version: _rawVersion, ...rawContent } = raw;
  const { version: _version, ...resolvedContent } = manifest;
  return `comparison-v1-${createHash("sha256").update(payload).update(stable(rawContent)).update(stable(resolvedContent)).digest("hex")}`;
}
