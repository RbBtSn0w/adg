#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const tarball = process.argv[2];
if (!tarball || !isAbsolute(tarball) || !existsSync(tarball)) throw new Error('Expected an absolute existing tarball path');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    shell: process.platform === "win32",
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
  const paths = new Set(run('tar', ['-tzf', tarball]).stdout.trim().split('\n').map(path => path.replace(/^package\//, '')));
  for (const required of ['dist/bin/adg.js', 'dist/src/adapters/antigravity-hook-runner.mjs', 'vendor/skills/LICENSE', 'vendor/skills/PROVENANCE.md']) {
    if (!paths.has(required)) throw new Error(`packed artifact is missing ${required}`);
  }
  if ([...paths].some(path => path.startsWith('vendor/skills/src/') || path === 'vendor/skills/package.json')) throw new Error('Duplicate vendored source in archive');
  const installRoot = join(scratch, "install");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installRoot, tarball]);

  const pkg = JSON.parse(readFileSync(join(installRoot, "node_modules", "@rbbtsn0w", "adg", "package.json"), "utf8"));
  const installedBin = join(installRoot, "node_modules", "@rbbtsn0w", "adg", "dist", "bin", "adg.js");
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, XDG_STATE_HOME: join(scratch, "state"), DISABLE_TELEMETRY: "1" };
  const version = run(process.execPath, [installedBin, "--version"], { env });
  if (version.stdout.trim() !== pkg.version) throw new Error(`installed CLI reported ${version.stdout.trim()}, expected ${pkg.version}`);
  run(process.execPath, [installedBin, "plugins", "--help"], { env });
  run(process.execPath, [installedBin, "skills", "--help"], { env });
  console.log(`package-smoke: installed ${tarball} and exercised plugins + skills. OK`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
