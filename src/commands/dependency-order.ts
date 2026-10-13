import type { PluginLock } from "../types.ts";

/** Shared lock traversal for explicit enablement and scoped runtime recovery. */
export function dependencyOrder(lock: PluginLock, roots: readonly string[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new Error(`dependency cycle: ${name}`);
    if (visited.has(name)) return;
    const entry = lock.plugins[name];
    if (!entry) throw new Error(`missing installed dependency: ${name}`);
    active.add(name);
    for (const dependency of Object.keys(entry.dependencies ?? {}).sort()) visit(dependency);
    active.delete(name);
    visited.add(name);
    order.push(name);
  };
  for (const root of roots) visit(root);
  return order;
}
