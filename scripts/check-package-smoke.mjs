#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const builtBin = join(root, "dist", "bin", "adg.js");
if (!existsSync(builtBin)) {
  console.error("package-smoke: dist/bin/adg.js is missing; run `npm run build` first.");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw result.error ?? new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

const scratch = mkdtempSync(join(tmpdir(), "adg-package-smoke-"));
try {
  const pack = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch]);
  const packed = JSON.parse(pack.stdout)[0];
  if (!packed?.filename) throw new Error("npm pack did not report a tarball filename");
  const paths = new Set((packed.files ?? []).map((entry) => entry.path));
  for (const required of ["dist/bin/adg.js", "vendor/skills/LICENSE", "vendor/skills/PROVENANCE.md"]) {
    if (!paths.has(required)) throw new Error(`packed artifact is missing ${required}`);
  }
  if ([...paths].some((path) => path.startsWith("vendor/skills/src/") || path === "vendor/skills/package.json")) {
    throw new Error("packed artifact contains duplicate vendored TypeScript/package metadata");
  }

  const tarball = join(scratch, packed.filename);
  const installRoot = join(scratch, "install");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, tarball]);

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const installedBin = join(installRoot, "node_modules", "@rbbtsn0w", "adg", "dist", "bin", "adg.js");
  const env = { ...process.env, HOME: scratch, XDG_STATE_HOME: join(scratch, "state"), DISABLE_TELEMETRY: "1" };
  const version = run(process.execPath, [installedBin, "--version"], { env });
  if (version.stdout.trim() !== pkg.version) throw new Error(`installed CLI reported ${version.stdout.trim()}, expected ${pkg.version}`);
  run(process.execPath, [installedBin, "plugins", "--help"], { env });
  run(process.execPath, [installedBin, "skills", "--help"], { env });
  console.log(`package-smoke: installed ${packed.filename} and exercised plugins + skills. OK`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
