/**
 * ADG type definitions mirroring the JSON Schemas under ../schemas.
 */

export const ADG_SCHEMA_VERSION = "adg.plugin/v1";
export const LOCK_VERSION = 2;

export interface AdgAuthor {
  name: string;
  url?: string;
  email?: string;
}

export interface AdgInterface {
  displayName?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface AdgDependency {
  name: string;
  version: string;
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
 * A partial-install selection. It is independent of packaging: the copied/hashed
 * file set is the manifest's declared payload (see `packageFilter`), while this
 * selection only narrows what the generated runtime manifests *expose*. Absent
 * selection = expose everything.
 */
export interface PluginSelection {
  /** Component categories to expose. */
  components: ComponentType[];
  /** When "skills" is selected, expose only these skill names (else all). */
  skills?: string[];
}

export interface LockEntry {
  /** Upstream provenance the plugin was installed from. */
  origin: PluginSource;
  version: string;
  /** Content digest of the installed directory (excluding generated adapters). */
  folderHash: Integrity;
  installedAt: string;
  updatedAt: string;
  dependencies?: Record<string, string>;
  /** Partial-install selection; absent means the whole plugin is exposed. */
  selection?: PluginSelection;
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
