import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AdgManifest, ComponentType, PluginSelection } from "./types.ts";
import { copyPluginDir, ensureDir, toPosix, writeJson } from "./fsutil.ts";
import { ADG_MANIFEST_PATH } from "./manifest.ts";
import { mcpConfigPath } from "./mcp.ts";
import { packageFilter } from "./package.ts";

const META_RE = /^(README|LICEN[CS]E|CHANGELOG|NOTICE)(\..+)?$/i;

function normalizeRelative(path: string): string {
  return path.replace(/^\.?[/\\]/, "").replaceAll("\\", "/").replace(/\/+$/, "");
}

function pathWithin(relPath: string, root: string): boolean {
  return relPath === root || relPath.startsWith(`${root}/`);
}

function declaredPaths(manifest: AdgManifest, component: ComponentType): string[] {
  const value = component === "mcp" ? mcpConfigPath(manifest) : manifest[component];
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(normalizeRelative).filter(Boolean);
}

function selectedSkillPaths(manifest: AdgManifest, names: readonly string[]): string[] {
  const declared = manifest.skills;
  if (Array.isArray(declared)) {
    const wanted = new Set(names);
    return declared
      .map(normalizeRelative)
      .filter((path) => wanted.has(basename(path)));
  }
  const root = normalizeRelative(declared ?? "./skills/");
  return names.map((name) => `${root}/${name}`);
}

/** The universal manifest that truthfully describes the effective installation. */
export function applySelectionToManifest(
  manifest: AdgManifest,
  selection?: PluginSelection,
): AdgManifest {
  const effective = structuredClone(manifest);
  if (!selection) return effective;

  const selected = new Set(selection.components);
  if (!selected.has("skills")) delete effective.skills;
  else if (selection.skills) effective.skills = selectedSkillPaths(manifest, selection.skills).map((path) => `./${path}`);
  if (!selected.has("agents")) delete effective.agents;
  if (!selected.has("commands")) delete effective.commands;
  if (!selected.has("hooks")) delete effective.hooks;
  if (!selected.has("apps")) delete effective.apps;
  if (!selected.has("mcp")) delete effective.mcpServers;
  return effective;
}

/**
 * Allow only files that belong to the effective selection. The canonical
 * manifest is generated separately, so authored `.agents` and vendor adapter
 * projections are never copied from the full source snapshot.
 */
export function effectivePackageFilter(
  manifest: AdgManifest,
  selection?: PluginSelection,
): (relPath: string) => boolean {
  const selected = new Set<ComponentType>(selection?.components ?? ["skills", "agents", "commands", "mcp", "hooks", "apps"]);
  const roots: string[] = [];
  for (const component of selected) {
    if (component === "skills" && selection?.skills) roots.push(...selectedSkillPaths(manifest, selection.skills));
    else roots.push(...declaredPaths(manifest, component));
  }

  return (rawPath: string): boolean => {
    if (rawPath === "") return true;
    const relPath = toPosix(rawPath);
    if (relPath === ".agents" || relPath === ADG_MANIFEST_PATH) return true;
    if (relPath.startsWith("../") || relPath === "..") return false;
    if (!relPath.includes("/") && META_RE.test(relPath)) return true;
    return roots.some((root) => pathWithin(relPath, root) || root.startsWith(`${relPath}/`));
  };
}

export interface MaterializePluginOptions {
  source: string;
  destination: string;
  manifest: AdgManifest;
  selection?: PluginSelection;
  build: (staging: string, effectiveManifest: AdgManifest) => void;
}

/** Build an effective plugin in a staging directory, then atomically replace it. */
export function materializePlugin(opts: MaterializePluginOptions): AdgManifest {
  const destination = resolve(opts.destination);
  const parent = dirname(destination);
  const token = randomUUID();
  const staging = join(parent, `.${basename(destination)}.adg-staging-${token}`);
  const backup = join(parent, `.${basename(destination)}.adg-backup-${token}`);
  const effectiveManifest = applySelectionToManifest(opts.manifest, opts.selection);
  ensureDir(parent);

  if (opts.selection) {
    const requiredPaths: string[] = [];
    for (const component of opts.selection.components) {
      if (component === "skills" && opts.selection.skills) requiredPaths.push(...selectedSkillPaths(opts.manifest, opts.selection.skills));
      else requiredPaths.push(...declaredPaths(opts.manifest, component));
    }
    const missing = requiredPaths.filter((path) => !existsSync(join(opts.source, path)));
    if (missing.length > 0) throw new Error(`selected payload path(s) not found: ${missing.join(", ")}`);
  }

  try {
    copyPluginDir(opts.source, staging, effectivePackageFilter(opts.manifest, opts.selection));
    writeJson(join(staging, ADG_MANIFEST_PATH), effectiveManifest);
    opts.build(staging, effectiveManifest);

    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return effectiveManifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(destination)) renameSync(backup, destination);
    else rmSync(backup, { recursive: true, force: true });
  }
}

/**
 * Atomically expose a new complete source snapshot for a callback. If building
 * the effective installation fails, restore the previous cache as part of the
 * same transaction.
 */
export function withPluginSourceCache<T>(
  source: string,
  cacheDir: string,
  manifest: AdgManifest,
  use: (cacheDir: string) => T,
): T {
  const target = resolve(cacheDir);
  if (resolve(source) === target) return use(target);
  const parent = dirname(target);
  const token = randomUUID();
  const staging = join(parent, `.${basename(target)}.adg-cache-${token}`);
  const backup = join(parent, `.${basename(target)}.adg-cache-backup-${token}`);
  ensureDir(parent);
  let committed = false;
  let hadPrevious = false;
  let promoted = false;
  try {
    copyPluginDir(source, staging, packageFilter(manifest, { includeProjections: false }));
    if (existsSync(target)) {
      renameSync(target, backup);
      hadPrevious = true;
    }
    renameSync(staging, target);
    promoted = true;
    const result = use(target);
    committed = true;
    rmSync(backup, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (promoted) rmSync(target, { recursive: true, force: true });
    if (hadPrevious && existsSync(backup)) renameSync(backup, target);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!committed && hadPrevious && existsSync(backup) && !existsSync(target)) renameSync(backup, target);
    if (committed) rmSync(backup, { recursive: true, force: true });
  }
}
