#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const provenance = readFileSync(join(root, "vendor", "skills", "PROVENANCE.md"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const commit = provenance.match(/Vendored commit \| `([0-9a-f]{40})`/)?.[1];
if (!commit) {
  console.error("vendor-upstream: PROVENANCE.md does not contain a full vendored commit.");
  process.exit(1);
}

function run(command, args, cwd, timeout = 300_000) {
  const env = { ...process.env, CI: "", DISABLE_TELEMETRY: "1" };
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout,
    env,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} exited with status ${result.status}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "adg-vendor-upstream-"));
const checkout = join(scratch, "vendor", "skills");
try {
  mkdirSync(join(scratch, "vendor"), { recursive: true });
  run("git", ["clone", "--quiet", "--no-checkout", "https://github.com/vercel-labs/skills.git", checkout], root);
  run("git", ["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", commit], root);
  run("git", ["-C", checkout, "checkout", "--quiet", "FETCH_HEAD"], root);

  const localSrc = join(root, "vendor", "skills", "src");
  const upstreamSrc = join(checkout, "src");
  for (const entry of readdirSync(localSrc, { withFileTypes: true })) {
    cpSync(join(localSrc, entry.name), join(upstreamSrc, entry.name), { recursive: true, force: true });
  }

  // Reproduce the root files that ADG-owned vendor patches import in the real
  // repository layout. Node resolves dependencies for these files from the
  // root, so expose the temporary checkout's node_modules at that level too.
  mkdirSync(join(scratch, "src"));
  cpSync(join(root, "src", "subprocess.ts"), join(scratch, "src", "subprocess.ts"));
  cpSync(join(root, "src", "telemetry.ts"), join(scratch, "src", "telemetry.ts"));
  cpSync(join(root, "package.json"), join(scratch, "package.json"));

  const pnpm = ["--yes", "pnpm@10.17.1"];
  run("npx", [...pnpm, "install", "--frozen-lockfile"], checkout);
  const otelDependencies = Object.entries(rootPackage.dependencies)
    .filter(([name]) => name.startsWith("@opentelemetry/"))
    .map(([name, version]) => `${name}@${version}`);
  run("npx", [...pnpm, "add", "--save-dev", ...otelDependencies], checkout);
  symlinkSync(
    join(checkout, "node_modules"),
    join(scratch, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  // These upstream assertions intentionally conflict with documented ADG
  // patches and are replaced by root focused tests: authenticated 403/404
  // fallback, hardened git execution, and ADG's narrowed `skills use` agents.
  const excluded = [
    "src/git.test.ts",
    "src/use.test.ts",
    "tests/blob-fetch-tree-auth.test.ts",
  ];
  run("npx", [...pnpm, "exec", "vitest", "run", ...excluded.flatMap((file) => ["--exclude", file])], checkout);
  console.log(`vendor-upstream: local vendored source passed upstream tests at ${commit.slice(0, 12)}. OK`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
