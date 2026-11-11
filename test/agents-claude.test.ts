import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunResult } from "../src/agents/base.ts";
import { parseClaudeMarketplaceDirectories, pruneStaleClaudeMarketplaces, syncMarketplace } from "../src/agents/claude.ts";

function result(ok: boolean, out = ""): RunResult {
  return { ok, out };
}

test("syncMarketplace falls back to add when marketplace update fails", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(false, "update failed");
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace only adds when the marketplace is not listed", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "other" }]));
    if (args[2] === "add") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", "/tmp/plugins"],
  ]);
});

test("syncMarketplace does not add when the marketplace update succeeds", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "update", "adg"],
  ]);
});

test("syncMarketplace warns when the add fallback also fails", () => {
  const warnings: string[] = [];
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg" }]));
    if (args[2] === "update") return result(false, "update failed");
    if (args[2] === "add") return result(false, "add failed");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg", runner, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /failed to sync Claude marketplace/i);
  assert.match(warnings[0]!, /add failed/);
});

test("parseClaudeMarketplaceDirectories keeps only directory-backed entries with a path", () => {
  const out = JSON.stringify([
    { name: "adg", source: "directory", path: "/global/plugins" },
    { name: "claude-plugins-official", source: "github" }, // no local path — never stale this way
    { name: "adg-deadbeef", source: "directory" }, // malformed: no path
    "not an object",
  ]);
  assert.deepEqual(parseClaudeMarketplaceDirectories(out), [{ name: "adg", path: "/global/plugins" }]);
});

test("parseClaudeMarketplaceDirectories returns [] on unparsable JSON", () => {
  assert.deepEqual(parseClaudeMarketplaceDirectories("not json"), []);
});

test("pruneStaleClaudeMarketplaces removes only ADG-owned marketplaces whose directory is gone", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") {
      return result(
        true,
        JSON.stringify([
          { name: "adg-deadbeef", source: "directory", path: "/tmp/gone" },
          { name: "adg-11111111", source: "directory", path: "/tmp/still-here" },
          { name: "my-own-marketplace", source: "directory", path: "/tmp/also-gone" }, // not ADG-owned — never touched
        ]),
      );
    }
    if (args[2] === "remove" && args[3] === "adg-deadbeef") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  const exists = (path: string): boolean => path === "/tmp/still-here";

  const outcome = pruneStaleClaudeMarketplaces(runner, exists);

  assert.deepEqual(outcome, {
    agent: "claude",
    skipped: false,
    removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }],
    errors: [],
  });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "remove", "adg-deadbeef"],
  ]);
});

test("pruneStaleClaudeMarketplaces reports a removal failure instead of throwing", () => {
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, JSON.stringify([{ name: "adg-deadbeef", source: "directory", path: "/tmp/gone" }]));
    if (args[2] === "remove") return result(false, "permission denied");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  const outcome = pruneStaleClaudeMarketplaces(runner, () => false);

  assert.deepEqual(outcome.removed, []);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0]!, /adg-deadbeef/);
  assert.match(outcome.errors[0]!, /permission denied/);
});

test("pruneStaleClaudeMarketplaces surfaces a list failure without attempting any removal", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    return result(false, "claude: not logged in");
  };

  const outcome = pruneStaleClaudeMarketplaces(runner, () => false);

  assert.deepEqual(outcome, { agent: "claude", skipped: false, removed: [], errors: ["claude: not logged in"] });
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});

test('Claude lifecycle returns marketplace/install/remove failures per target', async () => {
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { runClaudeLifecycle } = await import('../src/agents/claude.ts');
 const root=mkdtempSync(join(tmpdir(),'adg-claude-failures-'));
 const ctx={pluginsDir:root,plugins:['one','two'],scope:'project' as const};
 try {
 const marketplace=runClaudeLifecycle(ctx,'activate',()=>result(false,'marketplace rejected'),()=>true);
 assert.equal(marketplace.failures?.[0]?.stage,'marketplace'); assert.deepEqual(marketplace.affected,[]);
 const runner=(args:string[])=>args[1]==='marketplace'?result(true,'[]'):result(false,'native rejected');
 const install=runClaudeLifecycle(ctx,'activate',runner,()=>true);
 assert.deepEqual(install.failures?.map(f=>[f.plugin,f.stage]),[['one','install'],['two','install']]);
 const refresh=runClaudeLifecycle(ctx,'refresh',runner,()=>true);
 assert.deepEqual(refresh.failures?.map(f=>f.stage),['inspect']);
 const remove=runClaudeLifecycle(ctx,'deactivate',runner,()=>true);
 assert.equal(remove.failures?.length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('Claude refresh verifies an indeterminate uninstall before installing', async () => {
 const { mkdtempSync, rmSync }=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {runClaudeLifecycle,claudeMarketplaceName,parseClaudePluginRecords}=await import('../src/agents/claude.ts');
 const root=mkdtempSync(join(tmpdir(),'adg-claude-readback-'));const ctx={pluginsDir:root,plugins:['one'],scope:'project' as const};const mutations:string[]=[];let inspections=0;
 try {
 const runner=(args:string[])=>{
   if(args[1]==='marketplace')return result(true,'[]');
   if(args[1]==='list')return result(true,JSON.stringify(inspections++===0?[{id:`one@${claudeMarketplaceName(root)}`,scope:'project',enabled:true}]:[]));
   mutations.push(args[1]!);
   return args[1]==='uninstall'?result(false,'not found'):result(true);
 };
 const refreshed=runClaudeLifecycle(ctx,'refresh',runner,()=>true);assert.deepEqual(refreshed.affected,['one']);assert.deepEqual(mutations,['uninstall','install']);assert.equal(inspections,2);
 assert.deepEqual(parseClaudePluginRecords(JSON.stringify([{id:`one@${claudeMarketplaceName(root)}`,scope:'project',enabled:false,version:'2.0.0'}]),claudeMarketplaceName(root),'project')?.map(p=>[p.name,p.enabled,p.version]),[['one',false,'2.0.0']]);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("Claude refresh parses stdout independently of diagnostic stderr for inspection and removal readback", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runClaudeLifecycle, claudeMarketplaceName } = await import("../src/agents/claude.ts");
  const root = mkdtempSync(join(tmpdir(), "adg-claude-stdout-"));
  let inspections = 0;
  const mutations: string[] = [];
  const runner = (args: string[]): RunResult => {
    if (args[1] === "marketplace") return result(true, "[]");
    if (args[1] === "list") {
      const stdout = JSON.stringify(inspections++ === 0 ? [{ id: `demo@${claudeMarketplaceName(root)}`, scope: "project", enabled: true }] : []);
      return { ok: true, stdout, stderr: "Diagnostic warning", out: `${stdout}\nDiagnostic warning` };
    }
    mutations.push(args[1]!);
    return args[1] === "uninstall" ? result(false, "indeterminate uninstall") : result(true);
  };
  try {
    const refreshed = runClaudeLifecycle({ pluginsDir: root, plugins: ["demo"], scope: "project" }, "refresh", runner, () => true);
    assert.deepEqual(refreshed.failures ?? [], []);
    assert.deepEqual(refreshed.affected, ["demo"]);
    assert.deepEqual(mutations, ["uninstall", "install"]);
    assert.equal(inspections, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude migration retirement keeps user data while ordinary removal retains its explicit semantics', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runClaudeLifecycle } = await import('../src/agents/claude.ts');
  const root = mkdtempSync(join(tmpdir(), 'adg-claude-preserve-data-'));
  const calls: string[][] = [];
  const runner = (args: string[]) => { calls.push(args); return result(true); };
  try {
    const ctx = { pluginsDir: root, plugins: ['old'], scope: 'project' as const };
    runClaudeLifecycle({ ...ctx, preserveData: true }, 'deactivate', runner, () => true);
    assert.ok(calls[0]?.includes('--keep-data'));
    runClaudeLifecycle(ctx, 'deactivate', runner, () => true);
    assert.equal(calls[1]?.includes('--keep-data'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Claude refresh preserves a native-disabled registration before uninstalling', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runClaudeLifecycle, claudeMarketplaceName } = await import('../src/agents/claude.ts');
  const root = mkdtempSync(join(tmpdir(), 'adg-claude-disabled-'));
  const mutations: string[][] = [];
  const runner = (args: string[]) => {
    if (args[1] === 'marketplace') return result(true, '[]');
    if (args[1] === 'list') return result(true, JSON.stringify([{ id: `old@${claudeMarketplaceName(root)}`, scope: 'project', enabled: false, version: '1.0.0' }]));
    mutations.push(args);
    return result(true);
  };
  try {
    const refreshed = runClaudeLifecycle({ pluginsDir: root, plugins: ['old'], scope: 'project' }, 'refresh', runner, () => true);
    assert.deepEqual(refreshed.preservedDisabled, ['old']);
    assert.deepEqual(mutations, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude refresh honors an explicit successor enable decision and retains native user data", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runClaudeLifecycle, claudeMarketplaceName } = await import("../src/agents/claude.ts");
  const root = mkdtempSync(join(tmpdir(), "adg-claude-explicit-enable-"));
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    if (args[1] === "marketplace") return result(true, "[]");
    if (args[1] === "list") return result(true, JSON.stringify([{ id: `next@${claudeMarketplaceName(root)}`, scope: "user", enabled: false, version: "1.0.0" }]));
    calls.push(args);
    return result(true);
  };
  try {
    const enabled = runClaudeLifecycle({ pluginsDir: root, plugins: ["next"], scope: "user", forceEnable: true }, "refresh", runner, () => true);
    assert.deepEqual(enabled.affected, ["next"]);
    assert.ok(calls.find(args => args[1] === "uninstall")?.includes("--keep-data"));
    assert.ok(calls.find(args => args[1] === "enable"));
    assert.equal(enabled.preservedDisabled, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
