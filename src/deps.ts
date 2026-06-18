import { satisfies } from "./semver.ts";
import type { AdgManifest } from "./types.ts";

export interface PluginCandidate {
  dir: string;
  manifest: AdgManifest;
}

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

/**
 * Compute a topological install order for `rootName` and its transitive
 * dependencies, using `candidates` (name -> plugin) as the resolution universe.
 *
 * Dependencies are emitted before the plugins that depend on them, with
 * `rootName` last. Missing dependencies, version-constraint violations, and
 * dependency cycles are reported as DependencyError.
 */
export function resolveInstallOrder(
  rootName: string,
  candidates: Map<string, PluginCandidate>,
): string[] {
  if (!candidates.has(rootName)) {
    throw new DependencyError(`plugin "${rootName}" not found among candidates`);
  }

  const order: string[] = [];
  const visited = new Set<string>(); // fully processed
  const onStack = new Set<string>(); // current DFS path (cycle detection)

  const visit = (name: string, requiredBy: string | null, constraint: string | null): void => {
    const candidate = candidates.get(name);
    if (!candidate) {
      throw new DependencyError(
        `missing dependency "${name}"${requiredBy ? ` required by "${requiredBy}"` : ""}`,
      );
    }
    if (constraint && !satisfies(candidate.manifest.version, constraint)) {
      throw new DependencyError(
        `version conflict: "${requiredBy}" requires "${name}@${constraint}" but found ${candidate.manifest.version}`,
      );
    }
    if (visited.has(name)) return;
    if (onStack.has(name)) {
      throw new DependencyError(`dependency cycle detected at "${name}"`);
    }

    onStack.add(name);
    for (const dep of candidate.manifest.dependencies ?? []) {
      visit(dep.name, name, dep.version);
    }
    onStack.delete(name);
    visited.add(name);
    order.push(name);
  };

  visit(rootName, null, null);
  return order;
}
