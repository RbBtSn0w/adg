import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableInventory } from "../src/update-executables.ts";
import type { AdgManifest } from "../src/types.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "adg-executable-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "hooks"));
  const manifest: AdgManifest = { schemaVersion: "adg.plugin/v1", name: "generated", description: "Synthetic payload", version: "1.0.0", hooks: "./hooks/", mcpServers: "./mcp.json" };
  const write = (file: string, value: unknown) => writeFileSync(join(dir, file), JSON.stringify(value));
  write("mcp.json", { mcpServers: { primary: { command: "synthetic-server", args: ["--secret=fixture-only"] } } });
  write("hooks/hooks.json", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo synthetic" }] }] } });
  return { dir, manifest, write };
}

test("same-file MCP additions and endpoint changes require distinct approvals, with private config hashed", (t) => {
  const { dir, manifest, write } = fixture(t);
  const first = executableInventory(dir, manifest, undefined, ["codex"]).filter((entry) => entry.component === "mcp");
  write("mcp.json", { mcpServers: { primary: { command: "synthetic-server", args: ["--secret=fixture-only"] }, second: { url: "https://example.invalid/secret-token" } } });
  const second = executableInventory(dir, manifest, undefined, ["codex"]).filter((entry) => entry.component === "mcp");
  assert.equal(second.length, 2);
  assert.ok(second.some((entry) => entry.id === first[0]!.id));
  assert.doesNotMatch(JSON.stringify(second.map(({ id, label }) => ({ id, label }))), /secret|example|fixture-only/);
  write("mcp.json", { servers: { primary: { command: "other-server" } } });
  assert.notEqual(executableInventory(dir, manifest, undefined, ["codex"]).find((entry) => entry.component === "mcp")!.id, first[0]!.id);
});

test("native overrides and autoloaded hooks are inventoried using actual adapter formats", (t) => {
  const { dir, manifest, write } = fixture(t);
  write("hooks/hooks-codex.json", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo codex-only" }] }] } });
  write("hooks/hooks-antigravity.json", { generated: { PreInvocation: [{ type: "command", command: "echo agy-only" }] } });
  const before = readFileSync(join(dir, "hooks/hooks.json"), "utf8");
  const inventory = executableInventory(dir, manifest);
  assert.equal(inventory.filter((entry) => entry.component === "hooks").length, 3);
  const codex = inventory.find((entry) => entry.label.startsWith("codex SessionStart hook"))!;
  assert.equal(codex.member, "hooks/hooks-codex.json");
  write("hooks/hooks-codex.json", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo codex-injected" }] }] } });
  assert.ok(!executableInventory(dir, manifest).some((entry) => entry.id === codex.id));
  assert.equal(readFileSync(join(dir, "hooks/hooks.json"), "utf8"), before);
  assert.equal(executableInventory(dir, { ...manifest, hooks: undefined }, undefined, ["claude"]).filter((entry) => entry.component === "hooks").length, 1);
});

test("hook additions and changed matching context are detected within the same file", (t) => {
  const { dir, manifest, write } = fixture(t);
  const inventory = () => executableInventory(dir, manifest, undefined, ["claude"]).filter((entry) => entry.component === "hooks");
  const before = inventory();
  write("hooks/hooks.json", { hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo synthetic" }, { type: "command", command: "echo injected" }] }] } });
  const after = inventory();
  assert.equal(after.length, 2);
  assert.ok(after.every((entry) => entry.id !== before[0]!.id));
});

test("unchanged configs are stable across staging locations and JSON key order; selection narrows executable surface", (t) => {
  const { dir, manifest, write } = fixture(t);
  const before = executableInventory(dir, manifest);
  const other = fixture(t);
  assert.deepEqual(executableInventory(other.dir, other.manifest), before);
  write("mcp.json", { mcpServers: { primary: { args: ["--secret=fixture-only"], command: "synthetic-server" } } });
  assert.deepEqual(executableInventory(dir, manifest), before);
  assert.deepEqual(executableInventory(dir, manifest, { components: ["skills"] }), []);
  assert.deepEqual(executableInventory(dir, manifest, { components: ["mcp"], mcp: [] }), []);
});

test("invalid or unreadable executable configs fail closed without leaking payloads", (t) => {
  const { dir, manifest, write } = fixture(t);
  write("mcp.json", { mcpServers: { broken: {} } });
  assert.throws(() => executableInventory(dir, manifest), /Invalid executable MCP/);
  write("mcp.json", { mcpServers: {} });
  write("hooks/hooks.json", { hooks: { SessionStart: [{ hooks: [{ command: "" }] }] } });
  assert.throws(() => executableInventory(dir, manifest), /Invalid executable hook/);
  writeFileSync(join(dir, "hooks/hooks.json"), "invalid-secret-token-json");
  assert.throws(() => executableInventory(dir, manifest), (error) => error instanceof Error && !error.message.includes("secret-token"));
});

test("invalid Antigravity canonical hooks and symlinked configs fail closed", (t) => {
  const { dir, manifest, write } = fixture(t);
  write("hooks/hooks.json", { hooks: { SessionStart: "invalid" } });
  assert.throws(() => executableInventory(dir, manifest, undefined, ["antigravity"]));
  const other = fixture(t);
  rmSync(join(dir, "mcp.json"));
  symlinkSync(join(other.dir, "mcp.json"), join(dir, "mcp.json"));
  assert.throws(() => executableInventory(dir, manifest, undefined, ["codex"]), /inside its plugin/);
});

test("sibling hook additions preserve existing approvals and duplicate handlers retain multiplicity", (t) => {
  const { dir, manifest, write } = fixture(t);
  const inventory = () => executableInventory(dir, manifest, undefined, ["codex"]).filter((entry) => entry.component === "hooks");
  const first = inventory();
  write("hooks/hooks.json", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo synthetic" }, { type: "command", command: "echo synthetic" }, { type: "command", command: "echo other" }] }] } });
  const next = inventory();
  assert.equal(next.length, 3);
  assert.equal(new Set(next.map(entry => entry.id)).size, 3);
  assert.ok(next.some(entry => entry.id === first[0]!.id));
});

test("changing the tool called by a Claude MCP hook requires review", (t) => {
  const { dir, manifest, write } = fixture(t);
  const inventory = (tool: string) => {
    write("hooks/hooks.json", { hooks: { PostToolUse: [{ hooks: [{ type: "mcp_tool", server: "local", tool }] }] } });
    return executableInventory(dir, manifest, { components: ["hooks"] }, ["claude"])[0]!;
  };
  assert.notEqual(inventory("inspect").id, inventory("run").id);
});
