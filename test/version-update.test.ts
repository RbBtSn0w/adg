import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getVersion } from "../bin/adg.ts";
import {
  checkForUpdate,
  formatUpdateNotice,
  readUpdateCache,
  writeUpdateCache,
  updateCacheDir,
} from "../src/update-check.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-ver-"));
}

// ---------------------------------------------------------------------------
// getVersion()
// ---------------------------------------------------------------------------

test("getVersion returns a semver string matching package.json", () => {
  const version = getVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, "expected a semver string");
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

// ---------------------------------------------------------------------------
// formatUpdateNotice()
// ---------------------------------------------------------------------------

test("formatUpdateNotice contains both versions", () => {
  const notice = formatUpdateNotice("0.1.1", "1.0.0");
  assert.ok(notice.includes("0.1.1"), "should mention current version");
  assert.ok(notice.includes("1.0.0"), "should mention latest version");
  assert.ok(notice.includes("npm install"), "should include the install command");
});
