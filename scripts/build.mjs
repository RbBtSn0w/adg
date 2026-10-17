#!/usr/bin/env node
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const require = createRequire(import.meta.url);

function resolveTscBin() {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch {
    const pkgPath = require.resolve("typescript/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binRel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.tsc ?? "bin/tsc");
    return resolve(dirname(pkgPath), binRel);
  }
}

// 1. Clean dist
rmSync(dist, { recursive: true, force: true });

// 2. Transpile TypeScript with tsconfig.build.json
const tscBin = resolveTscBin();
const tscResult = spawnSync(
  process.execPath,
  [tscBin, "-p", "tsconfig.build.json", "--noCheck"],
  { cwd: root, stdio: "inherit" }
);
if (tscResult.status !== 0) {
  process.exit(tscResult.status ?? 1);
}

// 3. Copy runtime hook runner module
const hookRunnerTarget = resolve(dist, "src", "adapters", "antigravity-hook-runner.mjs");
mkdirSync(dirname(hookRunnerTarget), { recursive: true });
cpSync(
  resolve(root, "src", "adapters", "antigravity-hook-runner.mjs"),
  hookRunnerTarget
);

// 4. Ensure CLI executable bit
try {
  chmodSync(resolve(dist, "bin", "adg.js"), 0o755);
} catch (err) {
  if (process.platform !== "win32") throw err;
}
