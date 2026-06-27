import type { AdgManifest } from "./types.ts";
import { mcpConfigPath } from "./mcp.ts";

/**
 * Manifest-driven packaging allowlist.
 *
 * A plugin ships only its *declared* payload — the component directories named
 * in the manifest plus a small set of canonical metadata files — never the
 * authoring repo's dev cruft (`src/`, `test/`, `docs/`, CI config, …). This is a
 * default-deny model: anything not derivable from the manifest is dropped, which
 * is both safer (no accidental secret/dev-file leakage) and consistent with the
 * lock's content hash.
 */

/** Top-level metadata files always shipped with a plugin, matched case-insensitively. */
const META_RE = /^(README|LICEN[CS]E|CHANGELOG|NOTICE)(\..+)?$/i;

/**
 * Generated runtime projections — shipped, but excluded from the content hash.
 * `.antigravity-plugin` is legacy: Antigravity now projects a root `plugin.json`
 * (auto-scan model), but the entry is kept so any pre-migration projection dir
 * stays hash-ignored rather than registering as spurious drift.
 */
export const PROJECTION_DIRS = [".claude-plugin", ".codex-plugin", ".antigravity-plugin"];

/** Extract the first path segment of a manifest component value (e.g. "./skills/" -> "skills"). */
function topSegment(p: string): string {
  return p.replace(/^\.?[/\\]/, "").split(/[/\\]/)[0] ?? "";
}

/**
 * The set of root-level entry names that constitute the authored plugin payload,
 * derived from the manifest's declared components plus the canonical `.agents/`
 * manifest home.
 */
export function packagedRoots(manifest: AdgManifest): Set<string> {
  // `.agents` is the canonical manifest home; `.adg-plugin` keeps legacy plugins
  // shippable during the deprecation window.
  const roots = new Set<string>([".agents", ".adg-plugin"]);
  const components: Array<string | string[] | undefined> = [
    manifest.skills,
    manifest.agents,
    manifest.commands,
    mcpConfigPath(manifest),
    manifest.hooks,
    manifest.apps,
  ];
  for (const c of components) {
    if (c === undefined) continue;
    for (const p of Array.isArray(c) ? c : [c]) {
      const seg = topSegment(p);
      if (seg) roots.add(seg);
    }
  }
  return roots;
}

/**
 * Build a predicate over a root-relative path: whether it belongs to the
 * packaged plugin. Used by both the copy step and the content hash so an
 * in-place plugin (copy skipped) and a copied install hash identically.
 *
 * `includeProjections` controls whether the generated runtime manifests count:
 * true when copying (they ship), false when hashing (so re-adapting is stable).
 */
export function packageFilter(
  manifest: AdgManifest,
  opts: { includeProjections: boolean },
): (relPath: string) => boolean {
  const roots = packagedRoots(manifest);
  return (relPath: string): boolean => {
    if (relPath === "") return true; // the plugin root itself
    const segments = relPath.split(/[/\\]/);
    const first = segments[0]!;
    if (roots.has(first)) return true;
    if (opts.includeProjections && PROJECTION_DIRS.includes(first)) return true;
    // Metadata files only count at the root level (a single segment).
    return segments.length === 1 && META_RE.test(first);
  };
}
