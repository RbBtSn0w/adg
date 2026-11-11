import type { PluginLock, SourceIntent } from "./types.ts";

export function sourceIntent(lock: PluginLock, source: string, ref?: string): SourceIntent | undefined {
  return lock.sources?.find((entry) => entry.source.toLowerCase() === source.toLowerCase() && entry.ref === ref);
}

export function setSourceIntent(lock: PluginLock, intent: SourceIntent): void {
  const previous = sourceIntent(lock, intent.source, intent.ref);
  lock.sources = [...(lock.sources ?? []).filter((entry) => entry !== previous), intent];
}
