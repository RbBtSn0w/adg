import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { folderHash } from "../src/hash.ts";
import { packageFilter, PROJECTION_DIRS } from "../src/package.ts";
import { installPlugin } from "../src/commands/install.ts";
import { ensureAntigravityRoot } from "../src/agents/antigravity.ts";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "../src/types.ts";
import { tmp, scaffoldSource } from "./helpers.ts";

test("folderHash is deterministic and order-independent", () => {
  const a = tmp();
  writeFileSync(join(a, "a.txt"), "alpha");
  writeFileSync(join(a, "b.txt"), "beta");
  const h1 = folderHash(a);

  const b = tmp();
  writeFileSync(join(b, "b.txt"), "beta");
  writeFileSync(join(b, "a.txt"), "alpha");
  const h2 = folderHash(b);

  assert.equal(h1, h2);
  rmSync(a, { recursive: true });
  rmSync(b, { recursive: true });
});

test("folderHash ignores excluded segments", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.txt"), "alpha");
  const before = folderHash(dir, [".claude-plugin"]);
  const sub = join(dir, ".claude-plugin");
  mkdirSync(sub);
  writeFileSync(join(sub, "plugin.json"), "{}");
  const after = folderHash(dir, [".claude-plugin"]);
  assert.equal(before, after, "generated adapter manifest must not change source hash");
  rmSync(dir, { recursive: true });
});

test("packaged folderHash agrees between source-with-cruft and copied install", () => {
  const work = tmp();
  const { dir, manifest } = scaffoldSource(work);
  const store = join(work, "store");
  const res = installPlugin({ source: dir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  const hashSource = () =>
    folderHash(dir, [".claude-plugin", ".codex-plugin"], packageFilter(manifest, { includeProjections: false }));
  // Install hashes the copied (allowlisted) dest; hashing the source under the
  // same allowlist must agree — in-place and copied installs are identical.
  assert.equal(res.folderHash, hashSource());
  // Dev cruft does not move the hash; declared payload does.
  writeFileSync(join(dir, "src", "more.ts"), "export const y = 2;\n");
  assert.equal(hashSource(), res.folderHash);
  writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: changed.\n---\n");
  assert.notEqual(hashSource(), res.folderHash);
  rmSync(work, { recursive: true });
});

test("Antigravity root projections do not change the authored plugin hash", () => {
  const dir = tmp();
  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "hooked",
    version: "1.0.0",
    description: "Hook hash fixture",
    hooks: "./hooks/",
  };
  mkdirSync(join(dir, ".agents"));
  writeFileSync(join(dir, ".agents", ".plugin.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "hooks"));
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "printf '{}'" }] }] } }),
  );
  const hash = () => folderHash(dir, PROJECTION_DIRS, packageFilter(manifest, { includeProjections: false }));
  const before = hash();

  ensureAntigravityRoot(dir);

  assert.equal(hash(), before);
  rmSync(dir, { recursive: true });
});
