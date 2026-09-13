#!/usr/bin/env node
import { chmodSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

// 1. Clean dist
rmSync(dist, { recursive: true, force: true });

// 2. Transpile TypeScript with tsconfig.build.json
const tscBin = resolve(root, "node_modules", "typescript", "bin", "tsc");
const tscResult = spawnSync(
  process.execPath,
  [tscBin, "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" }
);
if (tscResult.status !== 0) {
  process.exit(tscResult.status ?? 1);
}

// 3. Copy runtime hook runner module
cpSync(
  resolve(root, "src", "adapters", "antigravity-hook-runner.mjs"),
  resolve(dist, "src", "adapters", "antigravity-hook-runner.mjs")
);

// 4. Ensure CLI executable bit
try {
  chmodSync(resolve(dist, "bin", "adg.js"), 0o755);
} catch (err) {
  if (process.platform !== "win32") throw err;
}
