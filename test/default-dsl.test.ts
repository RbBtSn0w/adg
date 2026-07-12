import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultDsl } from "../src/default-dsl.ts";
import { addPlugins } from "../src/commands/install.ts";
import { readManifest } from "../src/manifest.ts";
import { updateLock } from "../src/commands/update.ts";
import { readLock } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";
import { resolveSourcePath } from "../src/source-path.ts";

function scratch(): string { return mkdtempSync(join(tmpdir(), "adg-default-dsl-")); }
function skill(root: string, name = "release"): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}.\n---\n`);
}

test("default DSL derives a skills plugin from the standard directory", () => {
  const root = scratch();
  try {
    skill(root);
    const result = resolveDefaultDsl(root, { name: "ASC Skills", description: "ASC." });
    assert.equal(result.manifest.name, "asc-skills");
    assert.equal(result.manifest.description, "ASC.");
    assert.equal(result.manifest.skills, "./skills/");
    assert.equal(result.manifest.hooks, undefined);
    assert.equal(result.manifest.mcpServers, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL telemetry exposes only kind, count, and outcome", () => {
  const root = scratch();
  const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  try {
    skill(root);
    resolveDefaultDsl(root, { name: "ASC Skills", description: "ASC." }, {
      telemetrySpan: { addEvent: (name: string, attributes: unknown) => { events.push({ name, attributes: attributes as Record<string, unknown> }); } } as never,
    });
    assert.deepEqual(events, [{ name: "adg.default_dsl.resolve", attributes: { "definition.kind": "default-dsl/v1", "components.count": 1, outcome: "success" } }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL fingerprint ignores description metadata", () => {
  const root = scratch();
  try {
    skill(root);
    const first = resolveDefaultDsl(root, { name: "ASC Skills", description: "From GitHub." });
    const second = resolveDefaultDsl(root, { name: "ASC Skills", description: "Offline fallback." });
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.manifest.version, second.manifest.version);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL accepts hooks-only and MCP-only plugin roots", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "demo" } } }));
    const result = resolveDefaultDsl(root, { name: "Demo", description: "Demo." });
    assert.deepEqual(result.manifest.skills, []);
    assert.equal(result.manifest.hooks, "./hooks/");
    assert.equal(result.manifest.mcpServers, "./.mcp.json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL rejects a root without a standard component", () => {
  const root = scratch();
  try { assert.throws(() => resolveDefaultDsl(root, { name: "empty", description: "Empty." }), /no default plugin component/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL identifies the skill with invalid frontmatter", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "SKILL.md"), "# Missing frontmatter\n");
    assert.throws(() => resolveDefaultDsl(root, { name: "broken", description: "Broken." }), /skills[/\\]broken[/\\]SKILL\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default DSL does not follow symlinked component files", () => {
  const root = scratch();
  const external = scratch();
  try {
    mkdirSync(join(root, "skills", "linked"), { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "---\nname: linked\ndescription: External.\n---\n");
    symlinkSync(join(external, "SKILL.md"), join(root, "skills", "linked", "SKILL.md"));
    assert.throws(() => resolveDefaultDsl(root, { name: "linked", description: "Linked." }), /invalid default skill file/);

    rmSync(join(root, "skills"), { recursive: true, force: true });
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(external, "hooks.json"), JSON.stringify({ hooks: {} }));
    symlinkSync(join(external, "hooks.json"), join(root, "hooks", "hooks.json"));
    assert.throws(() => resolveDefaultDsl(root, { name: "linked", description: "Linked." }), /invalid default hooks configuration/);

    rmSync(join(root, "hooks"), { recursive: true, force: true });
    writeFileSync(join(external, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    symlinkSync(join(external, ".mcp.json"), join(root, ".mcp.json"));
    assert.throws(() => resolveDefaultDsl(root, { name: "linked", description: "Linked." }), /invalid default MCP configuration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("default DSL does not traverse a symlinked skills root", () => {
  const root = scratch();
  const external = scratch();
  try {
    skill(external);
    symlinkSync(join(external, "skills"), join(root, "skills"), "dir");
    assert.throws(() => resolveDefaultDsl(root, { name: "linked", description: "Linked." }), /no default plugin component/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("default DSL rejects component symlinks while manifest inheritance only probes defaults", () => {
  const root = scratch();
  const external = scratch();
  try {
    skill(root);
    writeFileSync(join(external, "reference.md"), "External.");
    symlinkSync(join(external, "reference.md"), join(root, "skills", "release", "reference.md"));
    assert.throws(() => resolveDefaultDsl(root, { name: "linked", description: "Linked." }), /must not contain symlinks/);

    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "explicit", version: "1.0.0", description: "Explicit." }));
    assert.equal(readManifest(root).skills, "./skills/");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("source paths reject Windows UNC and drive-qualified inputs", () => {
  const root = scratch();
  try {
    assert.throws(() => resolveSourcePath(root, "\\\\server\\share\\plugin"), /path must stay within the source root/);
    assert.throws(() => resolveSourcePath(root, "C:\\plugin"), /path must stay within the source root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("addPlugins installs a raw skills repository as a default plugin", async () => {
  const root = scratch();
  const store = join(root, "store");
  try {
    skill(root, "metadata");
    const result = await addPlugins({ spec: root, pluginsDir: store, targets: ["codex"], now: "2026-07-12T00:00:00Z" });
    assert.equal(result.installed.length, 1);
    assert.ok(result.installed[0]!.name.startsWith("adg-default-dsl-"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("addPlugins selects a structural source root supplied through --path", async () => {
  const root = scratch();
  const store = join(root, "store");
  try {
    const source = join(root, "packages", "release-tools");
    skill(source, "ship");
    const result = await addPlugins({ spec: root, path: "packages/release-tools", as: "release-tools", pluginsDir: store, targets: ["codex"], now: "2026-07-12T00:00:00Z" });
    assert.deepEqual(result.order, ["release-tools"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("addPlugins rejects a --path that escapes the source root", async () => {
  const parent = scratch();
  try {
    const source = join(parent, "source");
    skill(source);
    skill(join(parent, "outside"));
    await assert.rejects(() => addPlugins({ spec: source, path: "../outside", pluginsDir: join(parent, "store") }), /path must stay within the source root/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("explicit manifest inherits standard component mappings it omits", () => {
  const root = scratch();
  try {
    skill(root);
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "explicit", version: "1.0.0", description: "Explicit." }));
    assert.equal(readManifest(root).skills, "./skills/");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest default inheritance does not emit structural-resolution telemetry", () => {
  const root = scratch();
  const events: string[] = [];
  try {
    skill(root);
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "explicit", version: "1.0.0", description: "Explicit." }));
    readManifest(root, { addEvent: (name: string) => { events.push(name); } } as never);
    assert.deepEqual(events, ["adg.manifest.read"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest ignores an overridden malformed default slot but rejects an inherited one", () => {
  const root = scratch();
  try {
    skill(root);
    writeFileSync(join(root, ".mcp.json"), "{not-json");
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "explicit", version: "1.0.0", description: "Explicit." }));
    assert.throws(() => readManifest(root), /invalid default MCP configuration/);

    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "explicit", version: "1.0.0", description: "Explicit.", mcpServers: "./custom-mcp.json" }));
    writeFileSync(join(root, "custom-mcp.json"), JSON.stringify({ mcpServers: {} }));
    assert.equal(readManifest(root).mcpServers, "./custom-mcp.json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a local structural plugin can be updated from its raw source", async () => {
  const root = scratch();
  const store = join(root, "store");
  try {
    skill(root, "one");
    await addPlugins({ spec: root, pluginsDir: store, targets: ["codex"], now: "2026-07-12T00:00:00Z" });
    const before = readLock(lockPath(store));
    const installedName = Object.keys(before.plugins)[0]!;
    const previousDescription = before.plugins[installedName]!.definition!.description;
    skill(root, "two");
    const result = updateLock(store, "2026-07-13T00:00:00Z");
    assert.equal(result.missing.length, 0);
    assert.equal(result.results[0]!.changed, true);
    const entry = readLock(lockPath(store)).plugins[result.results[0]!.name]!;
    assert.equal(entry.definition?.kind, "default-dsl/v1");
    assert.equal(entry.definition?.description, previousDescription);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a structural plugin refuses a silent manifest-definition switch on update", async () => {
  const root = scratch();
  const store = join(root, "store");
  try {
    skill(root);
    await addPlugins({ spec: root, pluginsDir: store, targets: ["codex"], now: "2026-07-12T00:00:00Z" });
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", ".plugin.json"), JSON.stringify({ schemaVersion: "adg.plugin/v1", name: "changed", version: "1.0.0", description: "Changed.", skills: "./skills/" }));
    assert.throws(() => updateLock(store), /definition changed from default DSL/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
