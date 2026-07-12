import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "../agents/index.ts";
import { installedPluginDir, lockPath, pluginSourceCacheDir } from "../paths.ts";
import { readLock } from "../lock.ts";
import { installPlugin } from "./install.ts";
import { resolveDefaultDsl } from "../default-dsl.ts";
import { ADG_MANIFEST_PATH } from "../manifest.ts";
import { writeJson } from "../fsutil.ts";

export interface UpdateResult {
  name: string;
  changed: boolean;
  version: string;
  sourceHash: string;
  installedHash: string;
}

export interface UpdateOptions {
  resync?: boolean;
  scope?: AgentScope;
  only?: string[];
  agents?: Agent[];
}

export interface UpdateLockResult {
  results: UpdateResult[];
  missing: string[];
  agents?: AgentSyncResult[];
}

/**
 * Refresh local sources and repair effective installations from their complete
 * source snapshots. Runtime installations are never treated as upstream input.
 */
export function updateLock(
  pluginsDir: string,
  now: string = new Date().toISOString(),
  opts: UpdateOptions = {},
): UpdateLockResult {
  const snapshot = readLock(lockPath(pluginsDir));
  const only = opts.only ? new Set(opts.only) : undefined;
  const results: UpdateResult[] = [];
  const missing: string[] = [];
  const changedNames: string[] = [];

  for (const [name, entry] of Object.entries(snapshot.plugins)) {
    if (only && !only.has(name)) continue;
    const installedDir = installedPluginDir(pluginsDir, name, entry.origin);
    const resolvedSource = entry.origin.type === "local" ? resolve(pluginsDir, entry.origin.path) : undefined;
    const localSource = resolvedSource && resolvedSource !== resolve(installedDir)
      ? resolvedSource
      : undefined;
    const cache = pluginSourceCacheDir(pluginsDir, name);
    const source = localSource && existsSync(localSource) ? localSource : cache;
    if (!existsSync(source)) {
      missing.push(name);
      continue;
    }

    if (entry.definition && localSource && existsSync(join(localSource, ADG_MANIFEST_PATH))) {
      throw new Error(`source definition changed from default DSL to a manifest for "${name}"; re-add or migrate the plugin explicitly`);
    }

    let installSource = source;
    let staging: string | undefined;
    let definition = entry.definition;
    if (!existsSync(join(source, ADG_MANIFEST_PATH))) {
      try {
        const generated = resolveDefaultDsl(source, { name, description: entry.definition?.description ?? name });
        if (entry.definition) definition = { ...entry.definition, description: generated.manifest.description, fingerprint: generated.fingerprint };
        staging = mkdtempSync(join(tmpdir(), "adg-default-update-"));
        cpSync(source, staging, { recursive: true });
        writeJson(join(staging, ADG_MANIFEST_PATH), generated.manifest);
        installSource = staging;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("no default plugin component")) throw error;
        // Non-plugin local directories continue through the normal manifest path.
      }
    }
    let result;
    try {
      result = installPlugin({
        source: installSource,
        pluginsDir,
        origin: entry.origin,
        selection: entry.selection,
        skipUnchanged: true,
        now,
        definition,
      });
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
    if (result.changed) changedNames.push(name);
    results.push({
      name,
      changed: result.changed,
      version: result.version,
      sourceHash: result.sourceHash,
      installedHash: result.installedHash,
    });
  }

  const out: UpdateLockResult = { results, missing };
  if (opts.resync && changedNames.length > 0) {
    const ctx = { pluginsDir, plugins: changedNames, scope: opts.scope ?? "project" };
    out.agents = (opts.agents ?? resolveAgents()).map((agent) => agent.refresh(ctx));
  }
  return out;
}
