/**
 * ADG type definitions mirroring the JSON Schemas under ../schemas.
 */

export const ADG_SCHEMA_VERSION = "adg.plugin/v1";
export const LOCK_VERSION = 4;

export interface AdgAuthor {
  name: string;
  url?: string;
  email?: string;
}

export interface AdgInterface {
  displayName?: string;
  shortDescription?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface AdgDependency {
  name: string;
  version: string;
}

export interface SelectionRequirement {
  components?: ComponentType[];
  skills?: string[];
}

export interface AdgManifest {
  schemaVersion: typeof ADG_SCHEMA_VERSION;
  name: string;
  version: string;
  description: string;
  author?: AdgAuthor;
  license?: string;
  category?: string;
  interface?: AdgInterface;
  skills?: string | string[];
  agents?: string;
  commands?: string;
  apps?: string;
  hooks?: string;
  mcpServers?: string;
  dependencies?: AdgDependency[];
  /** Mandatory payload closure when a component is selected. */
  selectionDependencies?: Partial<Record<ComponentType, SelectionRequirement>>;
  strict?: boolean;
  homepage?: string;
  changelog?: string;
}

/**
 * Discriminated source union shared by marketplace entries (where to find a
 * plugin) and lock entries (where a plugin came from). `local.path` is relative
 * to the file that holds it; `github`/`git` carry an optional sub-path for
 * monorepos.
 */
export type PluginSource =
  | { type: "local"; path: string }
  | { type: "github"; repo: string; ref?: string; path?: string }
  | { type: "git"; url: string; ref?: string; path?: string };

export type SourceType = PluginSource["type"];

/** Self-describing content digest, e.g. "sha256-<hex>". */
export type Integrity = string;

/** The component categories a plugin can expose. */
export const COMPONENT_TYPES = ["skills", "agents", "commands", "mcp", "hooks", "apps"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * A partial-install selection. It defines both the effective on-disk payload and
 * the generated runtime manifests. The complete source remains in ADG's cache;
 * absent selection materializes everything declared by the source manifest.
 */
export interface PluginSelection {
  /** Component categories to expose. */
  components: ComponentType[];
  /** When "skills" is selected, expose only these skill names (else all). */
  skills?: string[];
  /** When "mcp" is selected, expose only these mcp server names (else all). */
  mcp?: string[];
}

/** Canonicalize user intent without adding derived component dependencies. */
export function normalizePluginSelection(selection: PluginSelection | undefined): PluginSelection | undefined {
  if (!selection) return undefined;
  const components = new Set<ComponentType>(selection.components);
  if (selection.skills !== undefined) components.add("skills");
  if (selection.mcp !== undefined) components.add("mcp");
  return {
    components: COMPONENT_TYPES.filter((component) => components.has(component)),
    ...(selection.skills !== undefined ? { skills: [...new Set(selection.skills)].sort() } : {}),
    ...(selection.mcp !== undefined ? { mcp: [...new Set(selection.mcp)].sort() } : {}),
  };
}

/** Expand mandatory component/skill requirements to a stable closure. */
export function resolveSelectionDependencies(
  manifest: AdgManifest,
  selection: PluginSelection | undefined,
): PluginSelection | undefined {
  const normalized = normalizePluginSelection(selection);
  if (!normalized) return undefined;
  const components = new Set<ComponentType>(normalized.components);
  let skills = normalized.skills ? new Set(normalized.skills) : undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const component of [...components]) {
      const requirement = manifest.selectionDependencies?.[component];
      for (const required of requirement?.components ?? []) {
        if (!components.has(required)) {
          components.add(required);
          changed = true;
        }
      }
      for (const skill of requirement?.skills ?? []) {
        if (!components.has("skills")) {
          components.add("skills");
          skills = new Set();
          changed = true;
        }
        // `skills === undefined` means the user selected every skill, which
        // already contains any required skill and must remain unrestricted.
        if (skills && !skills.has(skill)) {
          skills.add(skill);
          changed = true;
        }
      }
    }
  }
  return {
    components: COMPONENT_TYPES.filter((component) => components.has(component)),
    ...(skills ? { skills: [...skills].sort() } : {}),
    ...(normalized.mcp !== undefined ? { mcp: [...new Set(normalized.mcp)].sort() } : {}),
  };
}

export type PluginState = "enabled" | "disabled";

export interface LockEntry {
  /** Upstream provenance the plugin was installed from. */
  origin: PluginSource;
  version: string;
  /** Content digest of the complete cached source payload. */
  sourceHash: Integrity;
  /** Immutable remote commit used to create this snapshot (v4+ remote entries). */
  resolvedRevision?: string;
  /** Content digest of the effective runtime installation. */
  installedHash: Integrity;
  installedAt: string;
  updatedAt: string;
  dependencies?: Record<string, string>;
  /** Partial-install selection; absent means the whole plugin is installed. */
  selection?: PluginSelection;
  /** Desired cross-agent projection state. Absent means enabled. */
  state?: PluginState;
}

export function pluginState(entry?: LockEntry | null): PluginState {
  return entry?.state ?? "enabled";
}

export interface PluginLock {
  version: number;
  plugins: Record<string, LockEntry>;
  lastSelected?: string[];
}

/**
 * Marketplace entry source, in the object form ADG generates for the runtime
 * export (Codex / vercel-labs `plugins` write `{ source: "local", path }` into
 * ~/.agents/plugins/marketplace.json). marketplace.json is a pure export for
 * runtime consumption; ADG's richer provenance/integrity lives in the lock.
 *
 * Hand-authored source catalogs (.agents/.marketplace.json) may use the simpler
 * string shorthand `"./asc"` (local path) or a remote tagged-union object — see
 * marketplace.schema.json. ADG's own code only ever produces/consumes this
 * object form, so callers handle it directly.
 */
export interface MarketplaceSource {
  source: string;
  path: string;
}

export interface MarketplacePlugin {
  name: string;
  source: MarketplaceSource;
  policy?: {
    installation?: "AVAILABLE" | "BLOCKED";
    authentication?: "ON_INSTALL" | "NONE";
  };
  category?: string;
}

export interface Marketplace {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string; url?: string };
  /** @deprecated prefer top-level `description`. */
  interface?: { displayName?: string };
  plugins: MarketplacePlugin[];
}

/** Structural equality for provenance/source comparison (collision checks). */
export function sameSource(a: PluginSource, b: PluginSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "local" && b.type === "local") return a.path === b.path;
  if (a.type === "github" && b.type === "github") return a.repo === b.repo && a.path === b.path;
  if (a.type === "git" && b.type === "git") return a.url === b.url && a.path === b.path;
  return false;
}
