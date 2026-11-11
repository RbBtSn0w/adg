import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { spawnAdg } from "./sandbox-helpers.mjs";
import { readLock } from "../src/lock.ts";
import { folderHash } from "../src/hash.ts";
import { installedPluginDir, lockPath, pluginCacheRoot } from "../src/paths.ts";

// (Regression: a marketplace rename removed every installed plugin and its source.)
test("CLI retains installed plugins across a marketplace restructure and explicitly migrates", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "adg-marketplace-e2e-"));
  try {
    const source = "fixture-org/marketplace";
    const releases = {
      "1.0.0": { commit: "1".repeat(40), plugins: ["legacy-app", "legacy-core", "legacy-optional", "legacy-tools"], archive: join(root, "v1.tar.gz") },
      "2.0.0": { commit: "2".repeat(40), plugins: ["modern-app", "modern-core", "modern-tools", "modern-guides", "modern-checks", "modern-build", "modern-flow"], archive: join(root, "v2.tar.gz") },
    };
    // Generate all payloads locally; no upstream repository content is used.
    for (const [version, release] of Object.entries(releases)) {
      const parent = join(root, version);
      const snapshot = join(parent, "snapshot");
      mkdirSync(join(snapshot, ".agents"), { recursive: true });
      writeFileSync(join(snapshot, ".agents/.marketplace.json"), JSON.stringify({
        name: "generated-marketplace",
        plugins: release.plugins.map((name) => ({ name, source: { source: "local", path: `./${name}` } })),
      }));
      for (const name of release.plugins) {
        const dir = join(snapshot, name);
        mkdirSync(join(dir, ".agents"), { recursive: true });
        writeFileSync(join(dir, ".agents/.plugin.json"), JSON.stringify({
          schemaVersion: "adg.plugin/v1", name, version, description: "Generated test plugin", skills: "./skills/", strict: true,
        }));
        for (const skill of ["demo", "extra"]) {
          mkdirSync(join(dir, "skills", skill), { recursive: true });
          writeFileSync(join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Generated fixture\n---\nSynthetic test instructions.\n`);
        }
      }
      await tar.create({ cwd: parent, file: release.archive, gzip: true }, ["snapshot"]);
    }
    const releaseFile = join(root, "releases.json");
    writeFileSync(releaseFile, JSON.stringify({ source, releases }));
    const store = join(root, ".agents/plugins");
    const cache = join(root, "cache");
    const state = join(root, "state");
    const emptyPath = join(root, "empty-path");
    const remoteLog = join(root, "remote.jsonl");
    mkdirSync(emptyPath);
    mkdirSync(join(state, "adg"), { recursive: true });
    writeFileSync(join(state, "adg/update-check.json"), JSON.stringify({ latestVersion: "0.0.0", checkedAt: new Date().toISOString() }));
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const env = {
      [pathKey]: emptyPath,
      NODE_OPTIONS: `--import=${new URL("./fixtures/marketplace-update/github-replay.mjs", import.meta.url).href}`,
      ADG_PLUGINS_HOME: store, ADG_CACHE_HOME: cache, XDG_STATE_HOME: state,
      DISABLE_TELEMETRY: "1", GITHUB_TOKEN: "", GH_TOKEN: "", NO_COLOR: "1",
      ADG_TEST_REMOTE_LOG: remoteLog, ADG_TEST_RELEASES: releaseFile,
    };
    const run = (args: string[], version = "2.0.0", expectedStatus = 0, extraEnv: NodeJS.ProcessEnv = {}) => {
      const { result } = spawnAdg(["plugins", ...args, ...(args[0] === "update" ? ["--verbose"] : []), "--global"], {
        isolationRoot: join(root, "agent-homes"), cwd: root, timeout: 45_000,
        env: { ...env, ADG_TEST_MARKETPLACE_VERSION: version, ...extraEnv },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
      return result.stdout;
    };
    const old = releases["1.0.0"];
    const current = releases["2.0.0"];
    const names = () => Object.keys(readLock(lockPath(store)).plugins).sort();
    run(["add", source, "--all", "--skill", "demo"], "1.0.0");
    assert.deepEqual(names(), [...old.plugins].sort());
    run(["disable", "legacy-optional"], "1.0.0");
    // This predates source-subscription metadata: preserve the unknown/selected
    // intent baseline rather than subscribing this scenario to future plugins.
    const initial = readLock(lockPath(store));
    delete initial.sources;
    writeFileSync(lockPath(store), JSON.stringify(initial));
    const before = readLock(lockPath(store));
    const beforeMarketplace = readFileSync(join(store, "marketplace.json"), "utf8");
    const payloads = old.plugins.map((name) => {
      const entry = before.plugins[name]!;
      assert.equal(entry.version, "1.0.0");
      assert.equal(entry.resolvedRevision, old.commit);
      assert.equal(entry.origin.type, "github");
      assert.equal("ref" in entry.origin, false);
      assert.deepEqual(entry.selection?.skills, ["demo"]);
      const dir = installedPluginDir(store, name, entry.origin);
      const sourceCache = join(pluginCacheRoot(store, env), name);
      assert.equal(existsSync(join(dir, "skills/extra")), false);
      assert.equal(existsSync(join(sourceCache, "skills/extra/SKILL.md")), true);
      return { name, dir, cache: sourceCache };
    }).map((item) => ({ ...item, hash: folderHash(item.dir), cacheHash: folderHash(item.cache) }));
    const verifyPreserved = () => {
      const after = readLock(lockPath(store));
      for (const item of payloads) {
        assert.deepEqual(after.plugins[item.name], before.plugins[item.name]);
        assert.equal(folderHash(item.dir), item.hash);
        assert.equal(folderHash(item.cache), item.cacheHash);
      }
    };
    const failedReport = run(["update"], "2.0.0", 1, { ADG_TEST_FAIL_TARBALL: "1" });
    assert.match(failedReport, /could not be checked/);
    assert.doesNotMatch(failedReport, /removed stale upstream|up to date/);
    verifyPreserved();
    assert.equal(readFileSync(join(store, "marketplace.json"), "utf8"), beforeMarketplace);
    const report = run(["update"], "2.0.0", 1);
    assert.match(report, /action required; current installation retained/);
    assert.match(report, /unmapped:legacy/);
    assert.match(report, /adg plugins update.*terminal/);
    assert.match(report, /0 ok.*1 awaiting review/);
    assert.doesNotMatch(report, /up to date \(0\)|removed stale upstream/);
    verifyPreserved();
    assert.equal(readFileSync(join(store, "marketplace.json"), "utf8"), beforeMarketplace);
    const listed = JSON.parse(run(["list", "--json"])) as { plugins: Array<{ name: string; state: string }> };
    assert.deepEqual(listed.plugins.map((plugin) => plugin.name).sort(), [...old.plugins].sort());
    assert.equal(listed.plugins.find((plugin) => plugin.name === "legacy-optional")!.state, "disabled");
    assert.ok(run(["marketplace", "list"]).includes(source));
    assert.match(run(["update", source], "2.0.0", 1), /action required; current installation retained/);
    verifyPreserved();
    run(["update", source, "--all"], "2.0.0", 1);
    verifyPreserved();
    assert.deepEqual(names(), [...old.plugins].sort(), "one-shot additions cannot bypass unresolved legacy decisions");
    run(["add", source, "--all"]);
    assert.deepEqual(names(), [...current.plugins].sort());
    for (const item of payloads) {
      assert.equal(existsSync(item.dir), false);
      assert.equal(existsSync(item.cache), false);
    }
    assert.match(run(["update", source]), /up to date \(7\)/);
    const requests = readFileSync(remoteLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { version: string; url: string });
    assert.ok(requests.some((request) => request.version === "1.0.0" && request.url.endsWith("/tarball/HEAD")));
    assert.ok(requests.filter((request) => request.version === "2.0.0" && request.url.endsWith("/tarball/HEAD")).length >= 3);
    assert.ok(requests.every((request) => ["commits/HEAD", "tarball/HEAD"].some((path) => request.url === `https://api.github.com/repos/${source}/${path}`)));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
