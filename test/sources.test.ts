import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  satisfies,
  compare,
  parseVersion,
  parsePrerelease,
  comparePrerelease,
  compareVersions,
  prereleaseChannel,
} from "../src/semver.ts";
import { resolveInstallOrder, DependencyError, type PluginCandidate } from "../src/deps.ts";
import { parseSource, cloneGitHub, scanPlugins, scanNativePlugins, type GitRunner, type GitHubSource } from "../src/sources.ts";
import { addPlugins } from "../src/commands/install.ts";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "../src/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-src-"));
}

function writePlugin(root: string, m: Partial<AdgManifest> & { name: string; version: string }): string {
  const dir = join(root, m.name);
  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    description: `${m.name} plugin.`,
    ...m,
  } as AdgManifest;
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", ".plugin.json"), JSON.stringify(manifest));
  return dir;
}

function candidate(name: string, version: string, deps?: AdgManifest["dependencies"]): [string, PluginCandidate] {
  const manifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name,
    version,
    description: "x",
    ...(deps ? { dependencies: deps } : {}),
  } as AdgManifest;
  return [name, { dir: `/virtual/${name}`, manifest }];
}

// ---- semver ----

test("semver parse and compare", () => {
  assert.deepEqual(parseVersion("v1.2.3-beta+build"), [1, 2, 3]);
  assert.equal(compare([1, 0, 0], [1, 0, 1]), -1);
  assert.equal(compare([2, 0, 0], [1, 9, 9]), 1);
});

test("semver prerelease parsing and comparison", () => {
  assert.deepEqual(parsePrerelease("1.2.3"), []);
  assert.deepEqual(parsePrerelease("0.3.0-beta.2"), ["beta", 2]);
  assert.deepEqual(parsePrerelease("v1.2.3-rc.1+build.5"), ["rc", 1]);
  // A hyphen inside build metadata is not a pre-release separator.
  assert.deepEqual(parsePrerelease("1.2.3+build-1"), []);

  // Stable outranks any pre-release of the same core version.
  assert.equal(compareVersions("0.3.0", "0.3.0-beta.2"), 1);
  // Newer pre-release of the same channel.
  assert.equal(compareVersions("0.3.0-beta.3", "0.3.0-beta.2"), 1);
  assert.equal(compareVersions("0.3.0-beta.2", "0.3.0-beta.3"), -1);
  assert.equal(compareVersions("0.3.0-beta.2", "0.3.0-beta.2"), 0);
  // Different core versions still decide first.
  assert.equal(compareVersions("0.4.0-beta.1", "0.3.0"), 1);

  // SemVer §11 identifier precedence: numeric < alphanumeric.
  assert.equal(comparePrerelease([1], ["alpha"]), -1);
  // Longer pre-release wins when shared fields are equal.
  assert.equal(comparePrerelease(["beta"], ["beta", 1]), -1);
  // Channel ordering: alpha < beta < rc.
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-beta.1"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-beta.9"), 1);

  assert.equal(prereleaseChannel("0.3.0-beta.2"), "beta");
  assert.equal(prereleaseChannel("1.0.0-rc.1"), "rc");
  assert.equal(prereleaseChannel("1.2.3"), null);
});

test("semver satisfies caret/tilde/exact/wildcard/comparator", () => {
  assert.equal(satisfies("0.2.5", "^0.2.0"), true);
  assert.equal(satisfies("0.3.0", "^0.2.0"), false, "caret on 0.x locks the minor");
  assert.equal(satisfies("1.9.9", "^1.2.0"), true);
  assert.equal(satisfies("2.0.0", "^1.2.0"), false);
  assert.equal(satisfies("1.2.9", "~1.2.0"), true);
  assert.equal(satisfies("1.3.0", "~1.2.0"), false);
  assert.equal(satisfies("1.2.3", "1.2.3"), true);
  assert.equal(satisfies("9.9.9", "*"), true);
  assert.equal(satisfies("1.5.0", ">=1.2.0"), true);
  assert.equal(satisfies("1.1.0", ">=1.2.0"), false);
});

// ---- dependency ordering ----

test("resolveInstallOrder emits dependencies before dependents", () => {
  const map = new Map<string, PluginCandidate>([
    candidate("asc", "0.1.0", [{ name: "github-cr", version: "^0.2.0" }]),
    candidate("github-cr", "0.2.0"),
  ]);
  assert.deepEqual(resolveInstallOrder("asc", map), ["github-cr", "asc"]);
});

test("resolveInstallOrder detects missing dependency", () => {
  const map = new Map<string, PluginCandidate>([candidate("asc", "0.1.0", [{ name: "ghost", version: "*" }])]);
  assert.throws(() => resolveInstallOrder("asc", map), (e: unknown) => e instanceof DependencyError && /missing dependency "ghost"/.test((e as Error).message));
});

test("resolveInstallOrder detects version conflict", () => {
  const map = new Map<string, PluginCandidate>([
    candidate("asc", "0.1.0", [{ name: "github-cr", version: "^0.3.0" }]),
    candidate("github-cr", "0.2.0"),
  ]);
  assert.throws(() => resolveInstallOrder("asc", map), (e: unknown) => e instanceof DependencyError && /version conflict/.test((e as Error).message));
});

test("resolveInstallOrder detects cycles", () => {
  const map = new Map<string, PluginCandidate>([
    candidate("a", "1.0.0", [{ name: "b", version: "*" }]),
    candidate("b", "1.0.0", [{ name: "a", version: "*" }]),
  ]);
  assert.throws(() => resolveInstallOrder("a", map), (e: unknown) => e instanceof DependencyError && /cycle/.test((e as Error).message));
});

// ---- source parsing ----

test("parseSource recognizes shorthand, url and local path", () => {
  const gh = parseSource("RbBtSn0w/plugins@v0.1.0");
  assert.equal(gh.kind, "github");
  if (gh.kind === "github") {
    assert.equal(gh.source, "RbBtSn0w/plugins");
    assert.equal(gh.ref, "v0.1.0");
    assert.equal(gh.sourceUrl, "https://github.com/RbBtSn0w/plugins.git");
  }
  const url = parseSource("https://github.com/owner/repo.git");
  assert.equal(url.kind, "github");

  const dir = tmp();
  const local = parseSource(dir);
  assert.equal(local.kind, "local");
  rmSync(dir, { recursive: true });
});

test("parseSource handles no-ref shorthand, ssh url and .git normalization", () => {
  const noRef = parseSource("owner/repo");
  assert.equal(noRef.kind, "github");
  if (noRef.kind === "github") {
    assert.equal(noRef.source, "owner/repo");
    assert.equal(noRef.owner, "owner");
    assert.equal(noRef.repo, "repo");
    assert.equal(noRef.ref, undefined);
  }

  const ssh = parseSource("git@github.com:owner/repo.git");
  assert.equal(ssh.kind, "github");
  if (ssh.kind === "github") {
    assert.equal(ssh.repo, "repo", ".git suffix is stripped");
    assert.equal(ssh.sourceUrl, "https://github.com/owner/repo.git");
  }

  const urlRef = parseSource("https://github.com/owner/repo.git@v1.2.3");
  assert.equal(urlRef.kind, "github");
  if (urlRef.kind === "github") {
    assert.equal(urlRef.repo, "repo");
    assert.equal(urlRef.ref, "v1.2.3");
  }
});

test("parseSource throws on an unparseable spec", () => {
  assert.throws(() => parseSource("not a valid spec!!"), /cannot parse install source/);
});

test("scanPlugins finds plugins by manifest name and does not descend into them", () => {
  const root = tmp();
  writePlugin(root, { name: "asc", version: "0.1.0" });
  writePlugin(root, { name: "github-cr", version: "0.2.0" });
  const found = scanPlugins(root);
  assert.deepEqual([...found.keys()].sort(), ["asc", "github-cr"]);
  rmSync(root, { recursive: true });
});

test("scanPlugins skips node_modules and .git", () => {
  const root = tmp();
  writePlugin(root, { name: "real", version: "1.0.0" });
  writePlugin(join(root, "node_modules"), { name: "vendored", version: "1.0.0" });
  writePlugin(join(root, ".git"), { name: "shouldnt-happen", version: "1.0.0" });
  const found = scanPlugins(root);
  assert.deepEqual([...found.keys()], ["real"]);
  rmSync(root, { recursive: true });
});

// ---- cloneGitHub arg construction (injected runner, no network) ----

test("cloneGitHub builds a depth-1 clone and adds --branch for a ref", () => {
  const calls: string[][] = [];
  const runner: GitRunner = (args) => { calls.push(args); };

  cloneGitHub(parseSource("owner/repo@v1.2.3") as GitHubSource, "/dest", { runner });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "clone", "--depth", "1", "--branch", "v1.2.3",
    "https://github.com/owner/repo.git", "/dest",
  ]);
});

test("cloneGitHub omits --branch when no ref is given", () => {
  const calls: string[][] = [];
  cloneGitHub(parseSource("owner/repo") as GitHubSource, "/dest", { runner: (a) => calls.push(a) });
  assert.deepEqual(calls[0], ["clone", "--depth", "1", "https://github.com/owner/repo.git", "/dest"]);
});

test("cloneGitHub enables cone-mode sparse-checkout and drops empty paths", () => {
  const calls: string[][] = [];
  cloneGitHub(parseSource("owner/repo@main") as GitHubSource, "/dest", {
    sparse: ["engineering", "", "design"],
    runner: (a) => calls.push(a),
  });

  assert.deepEqual(calls[0], [
    "clone", "--depth", "1", "--branch", "main",
    "--filter=blob:none", "--sparse",
    "https://github.com/owner/repo.git", "/dest",
  ]);
  assert.deepEqual(calls[1], ["-C", "/dest", "sparse-checkout", "set", "engineering", "design"]);
});

// ---- end-to-end install ----

test("local add resolves and installs dependencies first", async () => {
  const work = tmp();
  const src = join(work, "src");
  mkdirSync(src, { recursive: true });
  writePlugin(src, { name: "asc", version: "0.1.0", skills: "./skills/", dependencies: [{ name: "github-cr", version: "^0.2.0" }] });
  writePlugin(src, { name: "github-cr", version: "0.2.0", skills: "./skills/" });

  // Deps are resolved within the source; select asc and its dep comes along.
  const store = join(work, "store");
  const { order, installed } = await addPlugins({ spec: src, pluginsDir: store, plugins: ["asc"], now: "2026-06-11T00:00:00Z" });

  assert.deepEqual(order, ["github-cr", "asc"]);
  assert.equal(installed.length, 2);
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.ok(lock.plugins.asc && lock.plugins["github-cr"]);
  assert.equal(lock.plugins.asc.dependencies["github-cr"], "^0.2.0");
  rmSync(work, { recursive: true });
});

test("github add (injected clone) records github provenance", async () => {
  const work = tmp();
  // Build a fake remote repo on disk.
  const remote = join(work, "remote");
  const repoPlugins = join(remote, "plugins");
  mkdirSync(repoPlugins, { recursive: true });
  writePlugin(repoPlugins, { name: "asc", version: "0.1.0", skills: "./skills/", dependencies: [{ name: "github-cr", version: "^0.2.0" }] });
  writePlugin(repoPlugins, { name: "github-cr", version: "0.2.0", skills: "./skills/" });

  // gitRunner copies the fake remote into the clone destination.
  const gitRunner: GitRunner = (args) => {
    const dest = args[args.length - 1]!;
    cpSync(remote, dest, { recursive: true });
  };

  const store = join(work, "store");
  const { order } = await addPlugins({
    spec: "RbBtSn0w/plugins",
    ref: "v0.1.0",
    path: "plugins/asc",
    pluginsDir: store,
    gitRunner,
    now: "2026-06-11T00:00:00Z",
  });

  assert.deepEqual(order, ["github-cr", "asc"]);
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.version, 2);
  assert.deepEqual(lock.plugins.asc.origin, {
    type: "github",
    repo: "RbBtSn0w/plugins",
    ref: "v0.1.0",
    path: "plugins/asc",
  });
  // Remote installs nest under a per-marketplace bucket (owner/repo -> owner__repo).
  const bucket = join(store, "RbBtSn0w__plugins");
  assert.ok(existsSync(join(bucket, "asc", ".agents", ".plugin.json")));
  assert.ok(existsSync(join(bucket, "github-cr", ".agents", ".plugin.json")));
  rmSync(work, { recursive: true });
});

test("scanNativePlugins resolves Claude before Codex when both coexist", () => {
  const dir = tmp();
  // A single plugin dir exposing BOTH native manifests, no canonical .agents.
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dual", version: "1.0.0", description: "Dual." }));
  mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
  writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "dual", version: "1.0.0", description: "Dual." }));

  const found = scanNativePlugins(dir);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "claude", "Claude (.claude-plugin) wins over Codex");
  rmSync(dir, { recursive: true });
});

test("scanNativePlugins recognizes codex-only and claude-only plugin dirs", () => {
  const root = tmp();
  mkdirSync(join(root, "cdx", ".codex-plugin"), { recursive: true });
  writeFileSync(join(root, "cdx", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "cdx", version: "1.0.0", description: "C", skills: [] }));
  mkdirSync(join(root, "cld", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "cld", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "cld", version: "1.0.0", description: "C" }));

  const byDir = Object.fromEntries(scanNativePlugins(root).map((p) => [p.dir.endsWith("cdx") ? "cdx" : "cld", p.kind]));
  assert.equal(byDir.cdx, "codex");
  assert.equal(byDir.cld, "claude");
  rmSync(root, { recursive: true });
});

test("scanNativePlugins prefers canonical .agents over a co-located native manifest", () => {
  const root = tmp();
  writePlugin(root, { name: "both", version: "1.0.0" }); // writes <root>/both/.agents/.plugin.json
  const pdir = join(root, "both");
  mkdirSync(join(pdir, ".codex-plugin"), { recursive: true });
  writeFileSync(join(pdir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "both", version: "1.0.0", description: "x", skills: [] }));

  const found = scanNativePlugins(root);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "adg", "canonical .agents/.plugin.json wins");
  rmSync(root, { recursive: true });
});
