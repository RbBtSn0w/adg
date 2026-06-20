import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { formatColumns, abbrevHome, ellipsizeStart } from "../src/render/ui.ts";
import { renderContents, renderPluginList, renderMarketplaceList } from "../src/render/plugins.ts";
import type { ListedPlugin } from "../src/commands/list.ts";
import type { MarketplaceGroup } from "../src/commands/marketplace.ts";

// The render layer (extracted in TD-2) is pure data -> lines, so it is tested
// here without spawning the CLI. NO_COLOR keeps picocolors output plain.

test("formatColumns lays items into width-bounded rows", () => {
  const out = formatColumns(["a", "bb", "ccc"], { width: 12, indent: 2, gutter: 2, maxColWidth: 4 });
  // colWidth = 3, cols = floor((12 - 2 + 2) / (3 + 2)) = 2 -> two per row.
  assert.deepEqual(out.split("\n"), ["  a    bb", "  ccc"]);
});

test("formatColumns truncates cells past maxColWidth with an ellipsis", () => {
  const out = formatColumns(["short", "wayTooLongName"], { width: 80, maxColWidth: 6 });
  assert.ok(out.includes("wayTo…"), "long cell is ellipsized to maxColWidth");
});

test("abbrevHome collapses the home prefix to ~", () => {
  const home = homedir();
  assert.equal(abbrevHome(home), "~");
  assert.equal(abbrevHome(join(home, "x", "y")), "~" + sep + join("x", "y"));
  assert.equal(abbrevHome("/etc/passwd"), "/etc/passwd");
});

test("ellipsizeStart tail-truncates with a leading ellipsis", () => {
  assert.equal(ellipsizeStart("abcdef", 4), "…def");
  assert.equal(ellipsizeStart("ab", 4), "ab");
});

test("renderContents expands each component type to its members", () => {
  const lines = renderContents({ skills: ["one", "two"], commands: [] }, 2);
  const text = lines.join("\n");
  assert.ok(text.includes("skills"), "type header present");
  assert.ok(text.includes("(2):"), "member count present");
  assert.ok(text.includes("one") && text.includes("two"), "members listed");
  assert.ok(!text.includes("commands"), "empty component types are skipped");
});

function listed(name: string, contents: Partial<Record<string, string[]>>): ListedPlugin {
  return {
    name,
    version: "1.0.0",
    origin: { type: "local", path: `./${name}` },
    folderHash: "sha256-0123456789abcdef0123",
    installedAt: "2026-06-11T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z",
    contents: { skills: [], agents: [], commands: [], mcp: [], hooks: [], apps: [], ...contents },
  } as ListedPlugin;
}

test("renderPluginList reports an empty store", () => {
  const lines = renderPluginList([], "/store");
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("no plugins recorded in /store"));
});

test("renderPluginList emits a row plus a provenance line per plugin", () => {
  const lines = renderPluginList([listed("alpha", { skills: ["s1"] })], "/store");
  const text = lines.join("\n");
  assert.ok(text.includes("alpha@1.0.0"), "name@version shown");
  assert.ok(text.includes("Agents:"), "agents column shown");
  assert.ok(text.includes("[local]"), "provenance line shown");
  assert.ok(text.includes("skills: 1"), "component count shown");
});

test("renderPluginList --verbose drills into members", () => {
  const plain = renderPluginList([listed("alpha", { skills: ["s1"] })], "/store");
  const verbose = renderPluginList([listed("alpha", { skills: ["s1"] })], "/store", { verbose: true });
  assert.ok(verbose.length > plain.length, "verbose adds member lines");
  assert.ok(verbose.join("\n").includes("s1"), "member name listed");
});

test("renderMarketplaceList groups by source and tags local sources", () => {
  const groups: MarketplaceGroup[] = [
    { source: "owner/repo", ref: "main", installed: ["a", "b"], remote: true },
    { source: "(local)", installed: ["c"], remote: false },
  ];
  const text = renderMarketplaceList(groups).join("\n");
  assert.ok(text.includes("owner/repo@main"), "remote source with ref");
  assert.ok(text.includes("(2 plugins)"), "pluralized count");
  assert.ok(text.includes("(1 plugin)"), "singular count");
  assert.ok(text.includes("local — re-run add"), "local sources tagged");
});

test("renderMarketplaceList reports an empty store", () => {
  assert.deepEqual(renderMarketplaceList([]), ["No plugins installed."]);
});
