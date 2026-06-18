import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { folderHash } from "../src/hash.ts";
import { packageFilter } from "../src/package.ts";
import { collectIssues, validateManifest, ManifestError, readManifest, ADG_MANIFEST_PATH, LEGACY_MANIFEST_PATH } from "../src/manifest.ts";
import { toAnthropicManifest } from "../src/adapters/anthropic.ts";
import { toCodexManifest } from "../src/adapters/openai.ts";
import { resolveSkills, readSkillDescription, skillDescriptionLoader } from "../src/skills.ts";
import { buildSkillRows, type SkillOption } from "../src/commands/multiselect-skills.ts";
import { emptyLock, upsertEntry } from "../src/lock.ts";
import { globalPluginsDir, projectPluginsDir, marketplaceSourcePath } from "../src/paths.ts";
import { initPlugin, initScaffold } from "../src/commands/init.ts";
import { adaptPlugin } from "../src/commands/adapt.ts";
import { installPlugin } from "../src/commands/install.ts";
import { updateLock } from "../src/commands/update.ts";
import { validatePlugin } from "../src/commands/validate.ts";
import { ADG_SCHEMA_VERSION, type AdgManifest, type PluginSelection } from "../src/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "adg-"));
}

const baseManifest: AdgManifest = {
  schemaVersion: ADG_SCHEMA_VERSION,
  name: "demo",
  version: "1.2.3",
  description: "Demo plugin.",
  skills: "./skills/",
  strict: true,
};

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

test("validateManifest accepts a valid manifest", () => {
  assert.doesNotThrow(() => validateManifest(baseManifest));
});

test("collectIssues flags bad name, version, schemaVersion", () => {
  const issues = collectIssues({ schemaVersion: "x", name: "Bad_Name", version: "1.0", description: "" });
  assert.ok(issues.some((i) => i.includes("schemaVersion")));
  assert.ok(issues.some((i) => i.includes("kebab-case")));
  assert.ok(issues.some((i) => i.includes("semantic")));
  assert.ok(issues.some((i) => i.includes("description")));
});

test("validateManifest throws ManifestError with issues", () => {
  assert.throws(() => validateManifest({}), (err: unknown) => err instanceof ManifestError);
});

test("anthropic adapter (strict) maps fields and keeps skills root", () => {
  const dir = tmp();
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, commands: "./commands/" });
  assert.equal(manifest.name, "demo");
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.commands, "./commands/");
  assert.equal(manifest.strict, undefined);
  rmSync(dir, { recursive: true });
});

test("anthropic adapter (non-strict) emits explicit skill list + strict:false", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  const { manifest } = toAnthropicManifest(dir, { ...baseManifest, strict: false });
  assert.equal(manifest.strict, false);
  assert.deepEqual(manifest.skills, ["./skills/one"]);
  rmSync(dir, { recursive: true });
});

test("adapters honor a selection (narrow categories and skills)", () => {
  const dir = tmp();
  for (const s of ["one", "two"]) {
    mkdirSync(join(dir, "skills", s), { recursive: true });
    writeFileSync(join(dir, "skills", s, "SKILL.md"), "x");
  }
  const manifest: AdgManifest = { ...baseManifest, commands: "./commands/", agents: "./agents/" };
  const selection: PluginSelection = { components: ["skills"], skills: ["one"] };

  const a = toAnthropicManifest(dir, manifest, selection).manifest;
  assert.equal(a.strict, false);
  assert.deepEqual(a.skills, ["./skills/one"]);
  assert.equal(a.commands, undefined, "unselected category must be dropped");
  assert.equal(a.agents, undefined);

  const c = toCodexManifest(dir, manifest, selection).manifest;
  assert.deepEqual(c.skills, ["one"]);
  rmSync(dir, { recursive: true });
});

test("installPlugin records a selection and reuses it on re-install", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "sel", dir: join(work, "src"), description: "Sel." });
  for (const s of ["one", "two"]) {
    mkdirSync(join(pluginDir, "skills", s), { recursive: true });
    writeFileSync(join(pluginDir, "skills", s, "SKILL.md"), "x");
  }
  const store = join(work, "store");

  const selection: PluginSelection = { components: ["skills"], skills: ["one"] };
  installPlugin({ source: pluginDir, pluginsDir: store, selection, now: "2026-06-11T00:00:00Z" });
  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock.plugins.sel.selection, selection);
  const codex = JSON.parse(readFileSync(join(store, "sel", ".codex-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(codex.skills, ["one"], "generated manifest exposes only the selected skill");

  // Re-install without a selection (e.g. an upgrade) must keep the prior one.
  installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-12T00:00:00Z" });
  const lock2 = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.deepEqual(lock2.plugins.sel.selection, selection);
  rmSync(work, { recursive: true });
});

test("codex adapter requires name/version/description/skills array", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "x");
  const { manifest, defaultPath } = toCodexManifest(dir, baseManifest);
  assert.equal(manifest.name, "demo");
  assert.deepEqual(manifest.skills, ["one"]);
  assert.ok(defaultPath.includes(".codex-plugin"));
  rmSync(dir, { recursive: true });
});

test("resolveSkills auto-scans only dirs with SKILL.md", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "good"), { recursive: true });
  writeFileSync(join(dir, "skills", "good", "SKILL.md"), "x");
  mkdirSync(join(dir, "skills", "empty"), { recursive: true });
  assert.deepEqual(resolveSkills(dir, baseManifest), ["good"]);
  rmSync(dir, { recursive: true });
});

test("readSkillDescription parses frontmatter, tolerates absence", () => {
  const dir = tmp();
  const md = join(dir, "SKILL.md");
  writeFileSync(md, "---\nname: a\ndescription: Do a thing well\n---\nbody");
  assert.equal(readSkillDescription(md), "Do a thing well");
  writeFileSync(md, "no frontmatter at all");
  assert.equal(readSkillDescription(md), undefined);
  writeFileSync(md, "---\nname: a\n---\nbody");
  assert.equal(readSkillDescription(md), undefined);
  assert.equal(readSkillDescription(join(dir, "missing.md")), undefined);
  rmSync(dir, { recursive: true });
});

test("skillDescriptionLoader is lazy and caches per skill", () => {
  const dir = tmp();
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), "---\ndescription: Alpha skill\n---\n");
  mkdirSync(join(dir, "skills", "beta"), { recursive: true });
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), "no fm");
  const load = skillDescriptionLoader(dir, baseManifest);
  assert.equal(load("alpha"), "Alpha skill");
  assert.equal(load("beta"), undefined);
  assert.equal(load("ghost"), undefined);
  // Cached: deleting the file after first read still returns the cached value.
  rmSync(join(dir, "skills", "alpha", "SKILL.md"));
  assert.equal(load("alpha"), "Alpha skill");
  rmSync(dir, { recursive: true });
});

test("buildSkillRows resolves descriptions only when toggled on", () => {
  const options: SkillOption[] = [
    { value: "alpha", label: "alpha" },
    { value: "beta", label: "beta" },
  ];
  const calls: string[] = [];
  const loadDescription = (v: string) => {
    calls.push(v);
    return v === "alpha" ? "Alpha desc" : undefined;
  };
  const off = buildSkillRows(options, { cursor: 0, selected: ["alpha"], showDesc: false, loadDescription });
  assert.equal(calls.length, 0, "no SKILL.md reads while descriptions are hidden");
  assert.ok(!off.join("\n").includes("Alpha desc"));

  const on = buildSkillRows(options, { cursor: 0, selected: ["alpha"], showDesc: true, loadDescription });
  assert.deepEqual(calls, ["alpha", "beta"], "reads each option once when shown");
  assert.ok(on.join("\n").includes("Alpha desc"), "renders the resolved description inline");
});

test("upsertEntry preserves installedAt and refreshes updatedAt", () => {
  const lock = emptyLock();
  upsertEntry(lock, "demo", { origin: { type: "local", path: "./demo" }, version: "1.0.0", folderHash: "sha256-aa" }, "2026-01-01T00:00:00Z");
  upsertEntry(lock, "demo", { origin: { type: "local", path: "./demo" }, version: "1.0.1", folderHash: "sha256-bb" }, "2026-02-01T00:00:00Z");
  assert.equal(lock.plugins.demo!.installedAt, "2026-01-01T00:00:00Z");
  assert.equal(lock.plugins.demo!.updatedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(lock.lastSelected, ["demo"]);
});

test("marketplaceSourcePath is relative to the marketplace.json grandparent (codex convention)", () => {
  const pdir = "/root/.agents/plugins";
  assert.equal(marketplaceSourcePath(pdir, "/root/.agents/plugins/foo"), "./.agents/plugins/foo");
  assert.equal(marketplaceSourcePath(pdir, "/root/.agents/plugins/owner__repo/bar"), "./.agents/plugins/owner__repo/bar");
});

test("marketplaceSourcePath is relative to a non-canonical store dir (explicit --dir)", () => {
  // A custom `--dir` store has no `.agents/` ancestor, so the path is relative
  // to the store itself — not a fixed two-levels-up that leaks parent names.
  const flat = "/cwd/store";
  assert.equal(marketplaceSourcePath(flat, "/cwd/store/myplug"), "./myplug");
  assert.equal(marketplaceSourcePath(flat, "/cwd/store/owner__repo/bar"), "./owner__repo/bar");

  const deep = "/cwd/a/b/c";
  assert.equal(marketplaceSourcePath(deep, "/cwd/a/b/c/myplug"), "./myplug");

  // The repo's own reference store `<repo>/plugins` resolves to `./<name>`.
  assert.equal(marketplaceSourcePath("/repo/plugins", "/repo/plugins/asc"), "./asc");
});

test("globalPluginsDir honors env precedence", () => {
  assert.equal(globalPluginsDir({ ADG_PLUGINS_HOME: "/x" } as NodeJS.ProcessEnv), "/x");
  assert.ok(globalPluginsDir({ XDG_STATE_HOME: "/state" } as NodeJS.ProcessEnv).startsWith("/state"));
});

test("projectPluginsDir stops at a .git root", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(projectPluginsDir(nested), join(root, ".agents", "plugins"));
  rmSync(root, { recursive: true });
});

test("init -> adapt -> install -> update end to end", () => {
  const work = tmp();
  const pluginsSrc = join(work, "src");
  const { pluginDir } = initPlugin({ name: "sample", dir: pluginsSrc, description: "Sample." });
  assert.ok(existsSync(join(pluginDir, ".agents", ".plugin.json")));

  const adapted = adaptPlugin(pluginDir, ["claude", "codex"]);
  assert.equal(adapted.length, 2);
  assert.ok(existsSync(join(pluginDir, ".claude-plugin", "plugin.json")));
  assert.ok(existsSync(join(pluginDir, ".codex-plugin", "plugin.json")));

  const store = join(work, "store");
  const res = installPlugin({ source: pluginDir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  assert.equal(res.name, "sample");
  assert.ok(existsSync(join(store, "sample", ".agents", ".plugin.json")));

  const lock = JSON.parse(readFileSync(join(store, ".plugin-lock.json"), "utf8"));
  assert.equal(lock.version, 2);
  assert.equal(lock.plugins.sample.folderHash, res.folderHash);
  assert.ok(res.folderHash.startsWith("sha256-"));
  assert.deepEqual(lock.plugins.sample.origin, { type: "local", path: "./sample" });

  // marketplace.json is the de-facto runtime export (no schemaVersion/integrity).
  const market = JSON.parse(readFileSync(join(store, "marketplace.json"), "utf8"));
  assert.equal(market.schemaVersion, undefined);
  assert.equal(market.plugins[0].name, "sample");
  assert.deepEqual(market.plugins[0].source, { source: "local", path: marketplaceSourcePath(store, join(store, "sample")) });

  // No content change => update reports unchanged.
  const upd = updateLock(store, "2026-07-01T00:00:00Z");
  assert.equal(upd.results[0]!.changed, false);

  // Mutate content => update reports changed and refreshes hash.
  writeFileSync(join(store, "sample", "README.md"), "changed");
  const upd2 = updateLock(store, "2026-07-02T00:00:00Z");
  assert.equal(upd2.results[0]!.changed, true);

  rmSync(work, { recursive: true });
});

// ---- packaging allowlist + legacy back-compat ----

function scaffoldSource(root: string, opts: { legacy?: boolean } = {}): { dir: string; manifest: AdgManifest } {
  const dir = join(root, "pkgdemo");
  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: "pkgdemo",
    version: "0.1.0",
    description: "Packaging demo.",
    skills: "./skills/",
  };
  const mfFile = join(dir, opts.legacy ? LEGACY_MANIFEST_PATH : ADG_MANIFEST_PATH);
  mkdirSync(dirname(mfFile), { recursive: true });
  writeFileSync(mfFile, JSON.stringify(manifest));
  mkdirSync(join(dir, "skills", "hello"), { recursive: true });
  writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: hi.\n---\n");
  writeFileSync(join(dir, "README.md"), "# pkgdemo\n");
  // Dev cruft that must never ship.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", "a.test.ts"), "// test\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  return { dir, manifest };
}

test("legacy .adg-plugin/plugin.json still resolves and installs", () => {
  const work = tmp();
  const { dir } = scaffoldSource(work, { legacy: true });
  // readManifest falls back to the legacy location.
  assert.equal(readManifest(dir).name, "pkgdemo");
  const store = join(work, "store");
  const res = installPlugin({ source: dir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  assert.equal(res.name, "pkgdemo");
  assert.ok(existsSync(join(store, "pkgdemo", ".adg-plugin", "plugin.json")), "legacy manifest ships");
  rmSync(work, { recursive: true });
});

test("install packages only declared payload, not dev cruft", () => {
  const work = tmp();
  const { dir } = scaffoldSource(work);
  const store = join(work, "store");
  installPlugin({ source: dir, pluginsDir: store, now: "2026-06-11T00:00:00Z" });
  const out = join(store, "pkgdemo");
  assert.ok(existsSync(join(out, ".agents", ".plugin.json")), "manifest ships");
  assert.ok(existsSync(join(out, "skills", "hello", "SKILL.md")), "declared skill ships");
  assert.ok(existsSync(join(out, "README.md")), "metadata ships");
  assert.ok(!existsSync(join(out, "src")), "src/ excluded");
  assert.ok(!existsSync(join(out, "test")), "test/ excluded");
  assert.ok(!existsSync(join(out, "package.json")), "package.json excluded");
  rmSync(work, { recursive: true });
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

test("initScaffold produces only .agents artifacts (no vendor projections)", () => {
  const work = tmp();

  // plugin (default): just .agents/.plugin.json + skill + README
  const p = initScaffold({ name: "p1", dir: join(work, "p"), type: "plugin" });
  assert.ok(existsSync(join(p.pluginDir, ".agents", ".plugin.json")));
  assert.ok(!existsSync(join(p.pluginDir, ".claude-plugin")), "no claude projection");
  assert.ok(!existsSync(join(p.pluginDir, ".codex-plugin")), "no codex projection");

  // marketplace: a catalog with an empty member list
  const m = initScaffold({ name: "cat", dir: join(work, "m"), type: "marketplace" });
  const catalog = JSON.parse(readFileSync(join(m.pluginDir, ".agents", ".marketplace.json"), "utf8"));
  assert.equal(catalog.name, "cat");
  assert.deepEqual(catalog.plugins, []);
  assert.ok(!existsSync(join(m.pluginDir, ".agents", ".plugin.json")), "marketplace dir is not also a plugin");

  // all: catalog root + one starter member plugin in a subdir, listed in the catalog
  const a = initScaffold({ name: "kit", dir: join(work, "a"), type: "all" });
  const allCatalog = JSON.parse(readFileSync(join(a.pluginDir, ".agents", ".marketplace.json"), "utf8"));
  assert.deepEqual(allCatalog.plugins, [{ name: "kit", source: { source: "local", path: "./kit" } }]);
  assert.ok(existsSync(join(a.pluginDir, "kit", ".agents", ".plugin.json")), "member plugin scaffolded");

  rmSync(work, { recursive: true });
});

test("validatePlugin flags a missing referenced path", () => {
  const work = tmp();
  const { pluginDir } = initPlugin({ name: "refcheck", dir: work });
  // Point commands at a non-existent dir.
  const mf = join(pluginDir, ".agents", ".plugin.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.commands = "./commands/";
  writeFileSync(mf, JSON.stringify(m));
  const res = validatePlugin(pluginDir);
  assert.equal(res.ok, false);
  assert.ok(res.issues.some((i) => i.includes("commands")));
  rmSync(work, { recursive: true });
});
