#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
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

function run(command, args, cwd, timeout = 300_000, retries = 0) {
  const env = { ...process.env, CI: "", DISABLE_TELEMETRY: "1" };
  delete env.CODEX_CI;
  delete env.CODEX_THREAD_ID;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.warn(`Retry attempt ${attempt}/${retries} for ${command} ${args.join(" ")}...`);
    }
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
      timeout,
      env,
      shell: process.platform === "win32",
    });
    if (!result.error && result.status === 0) {
      return;
    }
    lastError = result.error ?? new Error(`${command} exited with status ${result.status}`);
  }
  throw lastError;
}

const scratch = mkdtempSync(join(tmpdir(), "adg-vendor-upstream-"));
const checkout = join(scratch, "vendor", "skills");
try {
  mkdirSync(join(scratch, "vendor"), { recursive: true });
  run("git", ["clone", "--quiet", "--no-checkout", "--depth", "1", "https://github.com/vercel-labs/skills.git", checkout], root, 300_000, 2);
  run("git", ["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", commit], root, 300_000, 2);
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
  run("npx", [...pnpm, "install", "--frozen-lockfile"], checkout, 300_000, 2);
  const otelDependencies = Object.entries(rootPackage.dependencies)
    .filter(([name]) => name.startsWith("@opentelemetry/"))
    .map(([name, version]) => `${name}@${version}`);
  run("npx", [...pnpm, "add", "--save-dev", ...otelDependencies], checkout, 300_000, 2);
  symlinkSync(
    join(checkout, "node_modules"),
    join(scratch, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  // Adapt fixture assumptions to ADG without dropping their behavior assertions.
  // Exact occurrence counts make upstream fixture drift fail for review.
  function adaptTest(file, from, to, count = 1) {
    const path = join(checkout, file);
    const source = readFileSync(path, "utf8");
    const actual = source.split(from).length - 1;
    if (actual !== count) throw new Error(`vendor-upstream: ${file} fixture drift (expected ${count}, got ${actual})`);
    writeFileSync(path, source.replaceAll(from, to));
  }
  for (const [file, count] of [["src/add.test.ts", 1], ["src/list.test.ts", 1], ["src/remove.test.ts", 2]]) {
    adaptTest(file, "'.local', 'state', 'skills'", "'.local', 'state', '.agents'", count);
  }
  adaptTest("src/cli.test.ts", "expect(output).not.toContain('OpenClaw community skills')", "expect(output).toContain('OpenClaw community skills')");
  adaptTest("src/use.test.ts", "Invalid agents: not-an-agent", "Unsupported agents for skills use --agent: not-an-agent");
  // ADG consumes one value per --agent, preserving a following source token.
  // Multiple agents are expressed with repeated flags and must still fail.
  adaptTest("src/use.test.ts", "const multiple = parseUseOptions(['source', '--agent', 'claude-code', 'codex']);", "const multiple = parseUseOptions(['source', '--agent', 'claude-code', '--agent', 'codex']);");
  adaptTest("src/git.test.ts", "default: simpleGitMock,", "simpleGit: simpleGitMock,");
  // Real execFile carries a custom promisifier that returns { stdout, stderr }.
  // Its upstream vi.fn mock omits that API, which ADG's wrapper uses.
  adaptTest("src/git.test.ts", "const execFileMock = vi.hoisted(() => vi.fn());", `const execFileMock = vi.hoisted(() => {
    const fn = vi.fn();
    Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
      value: (...args: unknown[]) => new Promise((resolve, reject) => {
        fn(...args, (error: unknown, stdout: string, stderr: string) =>
          error ? reject(error) : resolve({ stdout, stderr }));
      }),
    });
    return fn;
  });`);

  // Only the upstream bundler artifact is inapplicable: ADG builds and installs
  // its own artifact in check:package-smoke. All other files run in full.
  const excludedFiles = ["tests/dist.test.ts"];
  // Every name is exact (suite + assertion). See PROVENANCE.md for replacement
  // root coverage. Do not widen these into suite or file exclusions.
  const excludedTestNames = [
    "git clone fallbacks allows the hard-coded LFS filter overrides required for clone",
    "getGitHubToken does not extract credentials from external tools",
    "fetchRepoTree lazy auth fallback does not invoke the token resolver on a non-rate-limit 403",
    "Pi agent support accepts pi as a valid --agent for skills use",
    "private repository installs installs from another Git host and preserves opted-in non-GitHub telemetry",
    "root-level disk install (issue #1603) installs the full directory (scripts/ + references/) for a root-level SKILL.md repo",
    "root-level lock hash covers the whole directory (issue #1603) changing a supporting file (scripts/) changes the computed lock hash",
    "direct telemetry endpoints sends event and audit requests directly to skills.sh with their query data",
    "direct telemetry endpoints honors DO_NOT_TRACK for both endpoints",
    "direct telemetry endpoints honors DISABLE_TELEMETRY for both endpoints",
  ];
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const testNamePattern = `^(?!(?:${excludedTestNames.map(escapeRegex).join("|")})$)`;
  run("npx", [...pnpm, "exec", "vitest", "run", "--testTimeout=15000", "--testNamePattern", testNamePattern, ...excludedFiles.flatMap((file) => ["--exclude", file])], checkout);
  console.log(`vendor-upstream: local vendored source passed upstream tests at ${commit.slice(0, 12)}. OK`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
