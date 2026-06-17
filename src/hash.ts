import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Directory names that never contribute to a plugin's content hash. */
const HASH_IGNORE = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Compute a deterministic content hash for a plugin directory.
 *
 * The hash incorporates each file's POSIX-normalized relative path and its
 * bytes, sorted by path so the result is stable across filesystems and walk
 * order. `extraIgnore` drops directory names by segment (e.g. generated adapter
 * manifests). `include`, when given, restricts the hash to the packaged payload
 * (root-relative path predicate, e.g. from `packageFilter`) so an in-place
 * plugin and a copied install hash identically.
 */
export function folderHash(
  dir: string,
  extraIgnore: Iterable<string> = [],
  include?: (relPath: string) => boolean,
): string {
  const ignore = new Set([...HASH_IGNORE, ...extraIgnore]);
  const files: string[] = [];
  collect(dir, dir, ignore, include, files);
  files.sort();

  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel, "utf8");
    hash.update("\0");
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\0");
  }
  // Self-describing digest (SRI-style) so the algorithm can evolve later.
  return `sha256-${hash.digest("hex")}`;
}

function collect(
  root: string,
  current: string,
  ignore: Set<string>,
  include: ((relPath: string) => boolean) | undefined,
  out: string[],
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const abs = join(current, entry.name);
    const rel = relative(root, abs);
    // Match ignore entries against any path segment (e.g. ".claude-plugin").
    if (rel.split(sep).some((seg) => ignore.has(seg))) continue;
    const relPosix = rel.split(sep).join("/");
    // Prune anything outside the packaged payload (directories too, by segment).
    if (include && !include(relPosix)) continue;
    if (entry.isDirectory()) {
      collect(root, abs, ignore, include, out);
    } else if (entry.isFile()) {
      out.push(relPosix);
    }
  }
}
