import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getVersion } from "../bin/adg.ts";
import {
  checkForUpdate,
  formatUpdateNotice,
  readUpdateCache,
  writeUpdateCache,
  updateCacheDir,
  resolveLatestForChannel,
} from "../src/update-check.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-ver-"));
}

const testDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// getVersion()
// ---------------------------------------------------------------------------

test("getVersion returns the package.json version", () => {
  const pkg = JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")) as { version: string };
  assert.equal(getVersion(), pkg.version);
});

// ---------------------------------------------------------------------------
// updateCacheDir()
// ---------------------------------------------------------------------------

test("updateCacheDir honors XDG_STATE_HOME", () => {
  const dir = updateCacheDir({ XDG_STATE_HOME: "/custom/state" } as NodeJS.ProcessEnv);
  assert.equal(dir, "/custom/state/adg");
});

test("updateCacheDir falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
  const dir = updateCacheDir({} as NodeJS.ProcessEnv);
  assert.ok(dir.endsWith("/adg"), "cache dir should end with /adg");
  assert.ok(dir.includes(".local/state"), "should fall back to ~/.local/state");
});

// ---------------------------------------------------------------------------
// readUpdateCache() / writeUpdateCache()
// ---------------------------------------------------------------------------

test("writeUpdateCache creates the directory and the file", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "1.2.3", checkedAt: "2026-01-01T00:00:00.000Z" }, env);
  const cache = readUpdateCache(env);
  assert.ok(cache !== null);
  assert.equal(cache!.latestVersion, "1.2.3");
  assert.equal(cache!.checkedAt, "2026-01-01T00:00:00.000Z");
  rmSync(root, { recursive: true });
});

test("readUpdateCache returns null when the file is absent", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  assert.equal(readUpdateCache(env), null);
  rmSync(root, { recursive: true });
});

test("readUpdateCache returns null when the file contains invalid JSON", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  mkdirSync(join(root, "adg"), { recursive: true });
  writeFileSync(join(root, "adg", "update-check.json"), "not-json");
  assert.equal(readUpdateCache(env), null);
  rmSync(root, { recursive: true });
});

// ---------------------------------------------------------------------------
// checkForUpdate()
// ---------------------------------------------------------------------------

test("checkForUpdate returns undefined when no cache exists", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  const result = checkForUpdate("0.1.0", env);
  assert.equal(result, undefined);
  rmSync(root, { recursive: true });
});

test("checkForUpdate returns undefined when cached version equals current", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.1.1", checkedAt: new Date().toISOString() }, env);
  const result = checkForUpdate("0.1.1", env);
  assert.equal(result, undefined);
  rmSync(root, { recursive: true });
});

test("checkForUpdate returns undefined when cached version is older than current", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.1.0", checkedAt: new Date().toISOString() }, env);
  const result = checkForUpdate("0.2.0", env);
  assert.equal(result, undefined);
  rmSync(root, { recursive: true });
});

test("checkForUpdate returns the newer version when the cache shows an upgrade", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "1.0.0", checkedAt: new Date().toISOString() }, env);
  const result = checkForUpdate("0.1.1", env);
  assert.equal(result, "1.0.0");
  rmSync(root, { recursive: true });
});

test("checkForUpdate does not show an update when cache is valid and current", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  // Fresh cache with same version as current.
  writeUpdateCache({ latestVersion: "0.1.1", checkedAt: new Date().toISOString() }, env);
  assert.equal(checkForUpdate("0.1.1", env), undefined);
  rmSync(root, { recursive: true });
});

test("checkForUpdate handles a malformed cached version without throwing", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "not-a-version", checkedAt: new Date().toISOString() }, env);
  assert.doesNotThrow(() => checkForUpdate("0.1.1", env));
  rmSync(root, { recursive: true });
});

test("checkForUpdate treats an invalid checkedAt timestamp as stale", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "1.0.0", checkedAt: "not-a-date" }, env);
  const refreshCalls: Array<{ currentVersion: string; env: NodeJS.ProcessEnv }> = [];
  const refresh = (currentVersion: string, refreshEnv: NodeJS.ProcessEnv) => {
    refreshCalls.push({ currentVersion, env: refreshEnv });
  };
  assert.equal(checkForUpdate("0.1.1", env, refresh), "1.0.0");
  assert.deepEqual(refreshCalls, [{ currentVersion: "0.1.1", env }]);
  rmSync(root, { recursive: true });
});

test("checkForUpdate reports a newer pre-release on the same channel", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.3.0-beta.3", checkedAt: new Date().toISOString() }, env);
  assert.equal(checkForUpdate("0.3.0-beta.2", env), "0.3.0-beta.3");
  rmSync(root, { recursive: true });
});

test("checkForUpdate reports a stable release when on a pre-release", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.3.0", checkedAt: new Date().toISOString() }, env);
  assert.equal(checkForUpdate("0.3.0-beta.2", env), "0.3.0");
  rmSync(root, { recursive: true });
});

test("checkForUpdate does not report an older stable when on a newer pre-release", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.2.9", checkedAt: new Date().toISOString() }, env);
  assert.equal(checkForUpdate("0.3.0-beta.2", env), undefined);
  rmSync(root, { recursive: true });
});

test("checkForUpdate returns undefined for an identical pre-release", () => {
  const root = tmp();
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  writeUpdateCache({ latestVersion: "0.3.0-beta.2", checkedAt: new Date().toISOString() }, env);
  assert.equal(checkForUpdate("0.3.0-beta.2", env), undefined);
  rmSync(root, { recursive: true });
});

// ---------------------------------------------------------------------------
// resolveLatestForChannel()
// ---------------------------------------------------------------------------

test("resolveLatestForChannel follows the matching channel for pre-release users", () => {
  // Beta user sees the newer beta even though `latest` tracks stable.
  assert.equal(
    resolveLatestForChannel("0.3.0-beta.2", { latest: "0.2.9", beta: "0.3.0-beta.3" }),
    "0.3.0-beta.3",
  );
  // Picks the max across channels (a newer stable beats an older beta).
  assert.equal(
    resolveLatestForChannel("0.3.0-beta.2", { latest: "0.3.0", beta: "0.3.0-beta.3" }),
    "0.3.0",
  );
});

test("resolveLatestForChannel uses latest for stable users and tolerates gaps", () => {
  assert.equal(resolveLatestForChannel("0.2.0", { latest: "0.3.0", beta: "0.4.0-beta.1" }), "0.3.0");
  assert.equal(resolveLatestForChannel("0.3.0-beta.2", { latest: "0.2.9" }), "0.2.9");
  assert.equal(resolveLatestForChannel("0.3.0-beta.2", undefined), undefined);
  assert.equal(resolveLatestForChannel("0.3.0-beta.2", {}), undefined);
});

// ---------------------------------------------------------------------------
// formatUpdateNotice()
// ---------------------------------------------------------------------------

test("formatUpdateNotice contains both versions", () => {
  const notice = formatUpdateNotice("0.1.1", "1.0.0");
  assert.ok(notice.includes("0.1.1"), "should mention current version");
  assert.ok(notice.includes("1.0.0"), "should mention latest version");
  assert.ok(notice.includes("npm install"), "should include the install command");
});
