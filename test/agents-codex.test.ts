import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { RunResult } from "../src/agents/base.ts";
import { parseCodexMarketplaceLocalSources, parseCodexStaleMarketplaceErrors, pruneStaleCodexMarketplaces, syncMarketplace } from "../src/agents/codex.ts";

function result(ok: boolean, out = ""): RunResult {
  return { ok, out };
}

test("syncMarketplace falls back to upgrade when add fails", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "add") return result(false, "add failed");
    if (args[2] === "upgrade") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg-12345678", runner);

  assert.deepEqual(calls, [
    ["plugin", "marketplace", "add", "/tmp/plugins"],
    ["plugin", "marketplace", "upgrade", "adg-12345678"],
  ]);
});

test("syncMarketplace warns when Codex add and upgrade both fail", () => {
  const warnings: string[] = [];
  const runner = (args: string[]): RunResult => {
    if (args[2] === "add") return result(false, "add failed");
    if (args[2] === "upgrade") return result(false, "upgrade failed");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  syncMarketplace("/tmp/plugins", "adg-12345678", runner, (message) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /failed to sync Codex marketplace/i);
  assert.match(warnings[0]!, /upgrade failed/);
});

function marketplaceListJson(marketplaces: Array<{ name: string; source?: string }>): string {
  return JSON.stringify({
    marketplaces: marketplaces.map((m) => ({
      name: m.name,
      root: "/irrelevant",
      ...(m.source ? { marketplaceSource: { sourceType: "local", source: m.source } } : {}),
    })),
  });
}

test("parseCodexMarketplaceLocalSources keeps only locally-sourced entries", () => {
  const out = JSON.stringify({
    marketplaces: [
      { name: "adg", root: "/x", marketplaceSource: { sourceType: "local", source: "/x" } },
      { name: "some-git-marketplace", root: "/y", marketplaceSource: { sourceType: "git", source: "https://example.com/repo.git" } },
      { name: "no-source" },
    ],
  });
  assert.deepEqual(parseCodexMarketplaceLocalSources(out), [{ name: "adg", path: "/x" }]);
});

test("parseCodexMarketplaceLocalSources returns [] on unparsable JSON", () => {
  assert.deepEqual(parseCodexMarketplaceLocalSources("not json"), []);
});

test("pruneStaleCodexMarketplaces removes only ADG-owned marketplaces whose directory is gone", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") {
      return result(
        true,
        marketplaceListJson([
          { name: "adg-deadbeef", source: "/tmp/gone" },
          { name: "adg-11111111", source: "/tmp/still-here" },
          { name: "claude-cowork", source: "/tmp/also-gone" }, // not ADG-owned — never touched
        ]),
      );
    }
    if (args[2] === "remove" && args[3] === "adg-deadbeef") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  // codexMarketplaceIsLive checks a derived marketplace.json path under the
  // registered source, not the raw source directory itself (see its doc).
  const liveSource = join("/tmp", "still-here");
  const exists = (path: string): boolean => path.startsWith(liveSource);

  const outcome = pruneStaleCodexMarketplaces(runner, {}, exists, () => [], () => {
    throw new Error("cache sweep must not run when the root is empty");
  });

  assert.deepEqual(outcome, {
    agent: "codex",
    skipped: false,
    removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }],
    errors: [],
  });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "remove", "adg-deadbeef"],
  ]);
});

test("pruneStaleCodexMarketplaces sweeps orphaned cache dirs left behind by a removed registration", () => {
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, marketplaceListJson([{ name: "adg-11111111", source: "/tmp/still-here" }]));
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  const removedDirs: string[] = [];
  const cacheRoot = join("/home", ".codex", "plugins", "cache");

  const outcome = pruneStaleCodexMarketplaces(
    runner,
    { CODEX_HOME: "/home/.codex" },
    () => true, // /tmp/still-here exists — the live marketplace is untouched
    (dir) => {
      assert.equal(dir, cacheRoot);
      return ["adg-11111111", "adg-deadbeef", "adg", "not-adg-owned"];
    },
    (path) => removedDirs.push(path),
  );

  // "adg-11111111" survives (still registered), "adg" (bare) is never touched
  // even though it isn't in the survivor set, and "not-adg-owned" isn't ours.
  assert.deepEqual(removedDirs, [join(cacheRoot, "adg-deadbeef")]);
  assert.deepEqual(outcome.removed, [{ name: "adg-deadbeef", path: join(cacheRoot, "adg-deadbeef") }]);
  assert.deepEqual(outcome.errors, []);
});

test("pruneStaleCodexMarketplaces reports a removal failure instead of throwing", () => {
  const runner = (args: string[]): RunResult => {
    if (args[2] === "list") return result(true, marketplaceListJson([{ name: "adg-deadbeef", source: "/tmp/gone" }]));
    if (args[2] === "remove") return result(false, "marketplace is pinned");
    return result(false, `unexpected call: ${args.join(" ")}`);
  };

  const outcome = pruneStaleCodexMarketplaces(runner, {}, () => false, () => []);

  assert.deepEqual(outcome.removed, []);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0]!, /adg-deadbeef/);
  assert.match(outcome.errors[0]!, /marketplace is pinned/);
});

test("pruneStaleCodexMarketplaces surfaces a list failure without attempting any removal", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    return result(false, "codex: no such config");
  };

  const outcome = pruneStaleCodexMarketplaces(runner, {}, () => false, () => []);

  assert.deepEqual(outcome, { agent: "codex", skipped: false, removed: [], errors: ["codex: no such config"] });
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});

test("parseCodexStaleMarketplaceErrors extracts every bulleted offender from a list failure", () => {
  const out =
    "failed to load marketplace(s):\n" +
    "  - `adg-deadbeef` at /tmp/gone-a: marketplace root does not contain a supported manifest\n" +
    "  - `some-other-marketplace` at /tmp/gone-b: marketplace root does not contain a supported manifest\n";
  assert.deepEqual(parseCodexStaleMarketplaceErrors(out), [
    { name: "adg-deadbeef", path: "/tmp/gone-a" },
    { name: "some-other-marketplace", path: "/tmp/gone-b" },
  ]);
});

test("parseCodexStaleMarketplaceErrors returns [] for an unrelated error", () => {
  assert.deepEqual(parseCodexStaleMarketplaceErrors("codex: not logged in"), []);
});

// Live-verified against codex-cli 0.154.0: `codex plugin marketplace list`
// fails the WHOLE call (not just the --json path) when ANY registered
// marketplace's root has no manifest — e.g. after the project behind an
// ADG-owned marketplace is deleted. One broken registration must not block
// pruning the rest.
test("pruneStaleCodexMarketplaces recovers when list fails on a stale ADG-owned marketplace, then prunes normally", () => {
  const calls: string[][] = [];
  let listAttempt = 0;
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") {
      listAttempt += 1;
      if (listAttempt === 1) {
        return result(
          false,
          "failed to load marketplace(s):\n  - `adg-deadbeef` at /tmp/gone: marketplace root does not contain a supported manifest",
        );
      }
      return result(true, marketplaceListJson([{ name: "adg-11111111", source: "/tmp/still-here" }]));
    }
    if (args[2] === "remove" && args[3] === "adg-deadbeef") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  const liveSource = join("/tmp", "still-here");
  const exists = (path: string): boolean => path.startsWith(liveSource);

  const outcome = pruneStaleCodexMarketplaces(runner, {}, exists, () => []);

  assert.deepEqual(outcome, {
    agent: "codex",
    skipped: false,
    removed: [{ name: "adg-deadbeef", path: "/tmp/gone" }],
    errors: [],
  });
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "remove", "adg-deadbeef"],
    ["plugin", "marketplace", "list", "--json"],
  ]);
});

test("pruneStaleCodexMarketplaces gives up without touching a non-ADG-owned marketplace that's blocking list", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    return result(
      false,
      "failed to load marketplace(s):\n  - `someone-elses-marketplace` at /tmp/not-ours: marketplace root does not contain a supported manifest",
    );
  };

  const outcome = pruneStaleCodexMarketplaces(runner, {}, () => false, () => []);

  assert.equal(outcome.removed.length, 0);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0]!, /someone-elses-marketplace/);
  // Never attempted a remove — only ever listed once, since there was nothing ADG-owned to recover.
  assert.deepEqual(calls, [["plugin", "marketplace", "list", "--json"]]);
});

// Live-verified: for a canonical `<root>/.agents/plugins` store, Codex
// registers the marketplace against `<root>` (see `codexMarketplaceRoot`), not
// the plugins directory. Deleting only `.agents/` (not the whole project root)
// must still count as stale.
test("pruneStaleCodexMarketplaces treats a canonical store as stale when its manifest is gone even though the registered root still exists", () => {
  const calls: string[][] = [];
  const runner = (args: string[]): RunResult => {
    calls.push(args);
    if (args[2] === "list") return result(true, marketplaceListJson([{ name: "adg-deadbeef", source: "/tmp/proj-root" }]));
    if (args[2] === "remove" && args[3] === "adg-deadbeef") return result(true);
    return result(false, `unexpected call: ${args.join(" ")}`);
  };
  // "/tmp/proj-root" itself exists (the project wasn't deleted), but neither
  // convention's marketplace.json does (.agents/ was deleted from under it).
  const exists = (path: string): boolean => path === "/tmp/proj-root";

  const outcome = pruneStaleCodexMarketplaces(runner, {}, exists, () => []);

  assert.deepEqual(outcome.removed, [{ name: "adg-deadbeef", path: "/tmp/proj-root" }]);
  assert.deepEqual(outcome.errors, []);
});
