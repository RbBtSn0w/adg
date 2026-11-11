import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPlugins, installPlugin } from "../src/commands/install.ts";
import { reviewExecutables } from "../src/commands/review-executables.ts";
import { readLock, writeLock } from "../src/lock.ts";
import { readManifest } from "../src/manifest.ts";
import { lockPath } from "../src/paths.ts";
import { installedHistory } from "../src/source-history.ts";
import { sourceIntent } from "../src/source-intent.ts";
import type { AdgManifest, SourceIntent } from "../src/types.ts";

const source = "example/public-authorization";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "adg-authorization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "store");
  const upstream = join(root, "upstream");
  const manifest: AdgManifest = { schemaVersion: "adg.plugin/v1", name: "demo", version: "1.0.0", description: "Synthetic authorization fixture", skills: "./skills/", hooks: "./hooks/" };
  mkdirSync(join(upstream, ".agents"), { recursive: true });
  writeFileSync(join(upstream, ".agents", ".plugin.json"), JSON.stringify(manifest));
  mkdirSync(join(upstream, "skills", "demo"), { recursive: true });
  writeFileSync(join(upstream, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Synthetic\n---\nSynthetic skill\n");
  mkdirSync(join(upstream, "hooks"));
  writeFileSync(join(upstream, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo synthetic" }] }] } }));
  installPlugin({ source: upstream, pluginsDir: store, origin: { type: "github", repo: source, path: "." }, targets: [], selection: { components: ["skills"] } });
  const lock = readLock(lockPath(store));
  return { root, store, upstream, manifest, lock, entry: lock.plugins.demo! };
}

test("adding another source member preserves deferred historical recovery", async t => {
  const f = fixture(t);
  const history = installedHistory(f.store, f.lock, source)[0]!;
  const deferredRecovery = [{ id: "historical-demo", history, skills: ["next:demo"] }];
  f.lock.sources = [{ source, mode: "selected", roots: ["demo"], excluded: [], appliedMigrations: [], history: [history], deferredRecovery }];
  writeLock(lockPath(f.store), f.lock);
  const savedRecovery = sourceIntent(readLock(lockPath(f.store)), source)?.deferredRecovery;
  const next = join(f.root, "next");
  mkdirSync(join(next, ".agents"), { recursive: true });
  writeFileSync(join(next, ".agents", ".plugin.json"), JSON.stringify({ ...f.manifest, name: "next", skills: undefined, hooks: undefined }));
  await addPlugins({ spec: source, pluginsDir: f.store, preparedSourceDir: next, plugins: ["next"], targets: [] });
  assert.deepEqual(sourceIntent(readLock(lockPath(f.store)), source)?.deferredRecovery, savedRecovery);
});

for (const legacy of ["missing", "unknown"] as const) {
  test(`${legacy} requested selection cannot authorize cached hooks absent from installed bytes`, async t => {
    const f = fixture(t);
    delete f.entry.selection;
    if (legacy === "missing") delete f.entry.selectionKnown;
    else f.entry.selectionKnown = false;
    const candidateManifest = { ...readManifest(f.upstream), selectionDependencies: { skills: { components: ["hooks" as const] } } };
    const intent: SourceIntent = { source, mode: "selected", roots: ["demo"], excluded: [], appliedMigrations: [] };
    const result = await reviewExecutables(f.store, intent, [{ name: "demo", old: f.entry, candidate: { dir: f.upstream, manifest: candidateManifest }, selection: { components: ["skills"] } }], ["claude"]);
    assert.equal(result.blockers.length, 1);
    assert.match(result.blockers[0]!, /Approval required: demo/);
  });
}
