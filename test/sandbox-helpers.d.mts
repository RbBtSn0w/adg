import type { SpawnSyncReturns } from "node:child_process";

export function spawnAdg(args: string[], options?: {
  env?: NodeJS.ProcessEnv;
  isolationRoot?: string;
  cwd?: string;
  timeout?: number;
}): { result: SpawnSyncReturns<string>; root: string };
