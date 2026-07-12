import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseCodexPluginConfig,
  planCodexMarketplaceCleanup,
  reconcileCodexMarketplaceAliases,
} from "../src/codex-marketplace-migration.ts";

/*
## Test Intent
### Risk
Codex treats a historical marketplace alias and `adg` as distinct plugin
identities. A scoped link/sync must remove only the identities it has already
reinstalled under `@adg`, or it can break an unrelated plugin.

### Why Automation
The cleanup order is stateful and depends on Codex's persisted configuration;
the planner must preserve untouched legacy entries and only remove a
marketplace after its final entry is gone.

### Why Existing Tests Insufficient
Existing tests cover marketplace registration, not selected-name cleanup,
orphan cleanup, or migration outcome reporting.

### Chosen Layer
Unit Test - parsing and planning are deterministic; invoking a user's Codex
configuration would be destructive and environment-dependent.

### Fragility Analysis
The fixture contains only TOML sections owned by the migrator. Assertions use
public Codex CLI arguments and result fields, rather than parser internals.

### If Omitted
A future cleanup can remove an unselected legacy identity or leave duplicate
skills without a measurable outcome.
*/

const config = `
[marketplaces.plugins]
source_type = "local"
source = "/Users/snow"

[marketplaces.adg]
source_type = "local"
source = "/Users/snow"

[marketplaces.unrelated]
source_type = "local"
source = "/tmp/other"

[plugins."design@plugins"]
enabled = true

[plugins."engineering@plugins"]
enabled = false

[plugins."design@adg"]
enabled = true

[plugins."design@retired"]
enabled = true

[plugins."other@unrelated"]
enabled = true
`;

test("plans scoped cleanup without removing another selected alias entry", () => {
  const parsed = parseCodexPluginConfig(config);
  const plan = planCodexMarketplaceCleanup(parsed, "/Users/snow", "adg", ["design"]);

  assert.deepEqual(plan.legacyMarketplaces, ["plugins"]);
  assert.deepEqual(plan.commands, [
    ["plugin", "remove", "design@plugins"],
    ["plugin", "remove", "design@retired"],
  ]);
});

test("does nothing when the canonical marketplace is the only same-root entry", () => {
  const parsed = parseCodexPluginConfig(`
[marketplaces.adg]
source = "/Users/snow"

[plugins."design@adg"]
enabled = true
`);

  assert.deepEqual(planCodexMarketplaceCleanup(parsed, "/Users/snow", "adg", ["design"]), {
    legacyMarketplaces: [],
    legacyPluginCount: 0,
    orphanPluginCount: 0,
    commands: [],
  });
});

test("reconciles only refreshed names and reports a deferred legacy alias", () => {
  const commands: string[][] = [];
  const reports: Array<Record<string, string | number>> = [];
  const result = reconcileCodexMarketplaceAliases({
    pluginsDir: "/Users/snow/.agents/plugins",
    marketplace: "adg",
    plugins: ["design"],
    readConfig: () => config,
    run: (command) => {
      commands.push(command);
      return { ok: true, out: "" };
    },
    report: (attributes) => reports.push(attributes),
  });

  assert.deepEqual(commands, [
    ["plugin", "remove", "design@plugins"],
    ["plugin", "remove", "design@retired"],
  ]);
  assert.equal(result.outcome, "deferred");
  assert.deepEqual(reports, [{
    "legacy.marketplace_count": 1,
    "legacy.plugin_count": 2,
    "legacy.orphan_plugin_count": 1,
    "migration.removed_plugin_count": 2,
    "migration.removed_marketplace_count": 0,
    "migration.outcome": "deferred",
  }]);
});

test("keeps a legacy marketplace when a plugin identity removal fails", () => {
  const commands: string[][] = [];
  const reports: Array<Record<string, string | number>> = [];
  const result = reconcileCodexMarketplaceAliases({
    pluginsDir: "/Users/snow/.agents/plugins",
    marketplace: "adg",
    plugins: ["design", "engineering"],
    readConfig: () => config,
    run: (command) => {
      commands.push(command);
      return { ok: command[2] !== "engineering@plugins", out: "remove failed" };
    },
    report: (attributes) => reports.push(attributes),
  });

  assert.deepEqual(commands, [
    ["plugin", "remove", "design@plugins"],
    ["plugin", "remove", "engineering@plugins"],
    ["plugin", "remove", "design@retired"],
  ]);
  assert.equal(result.outcome, "partial");
  assert.equal(reports[0]!["migration.removed_marketplace_count"], 0);
});

test("reports an orphan-only cleanup as completed", () => {
  const reports: Array<Record<string, string | number>> = [];
  const result = reconcileCodexMarketplaceAliases({
    pluginsDir: "/Users/snow/.agents/plugins",
    marketplace: "adg",
    plugins: ["design"],
    readConfig: () => `
[marketplaces.adg]
source = "/Users/snow"

[plugins."design@adg"]
enabled = true

[plugins."design@retired"]
enabled = true
`,
    run: () => ({ ok: true, out: "" }),
    report: (attributes) => reports.push(attributes),
  });

  assert.equal(result.outcome, "completed");
  assert.deepEqual(reports[0], {
    "legacy.marketplace_count": 0,
    "legacy.plugin_count": 0,
    "legacy.orphan_plugin_count": 1,
    "migration.removed_plugin_count": 1,
    "migration.removed_marketplace_count": 0,
    "migration.outcome": "completed",
  });
});

/*
## Test Intent
### Risk
Removing an empty same-root legacy marketplace can be reported as "none", hiding a successful cleanup action from migration telemetry.
### Why Automation
The outcome depends on the planner's interaction with the executor; manual Codex configuration testing would be destructive and cannot reliably assert telemetry fields.
### Why Existing Tests Insufficient
Existing outcome tests cover aliases that contain plugin identities and orphan-only plugin cleanup, but not a removable empty marketplace.
### Chosen Layer
Unit Test - parsing, cleanup planning, and reported outcome are deterministic with an injected command runner.
### Fragility Analysis
The assertion observes public CLI command arguments and result/telemetry values, not parser or control-flow internals.
### If Omitted
Successful cleanup can be indistinguishable from no migration work in operational telemetry.
*/
test("reports an empty legacy marketplace cleanup as completed", () => {
  const commands: string[][] = [];
  const reports: Array<Record<string, string | number>> = [];
  const result = reconcileCodexMarketplaceAliases({
    pluginsDir: "/Users/snow/.agents/plugins",
    marketplace: "adg",
    plugins: [],
    readConfig: () => `
[marketplaces.plugins]
source = "/Users/snow"

[marketplaces.adg]
source = "/Users/snow"
`,
    run: (command) => {
      commands.push(command);
      return { ok: true, out: "" };
    },
    report: (attributes) => reports.push(attributes),
  });

  assert.deepEqual(commands, [["plugin", "marketplace", "remove", "plugins"]]);
  assert.equal(result.outcome, "completed");
  assert.deepEqual(reports[0], {
    "legacy.marketplace_count": 1,
    "legacy.plugin_count": 0,
    "legacy.orphan_plugin_count": 0,
    "migration.removed_plugin_count": 0,
    "migration.removed_marketplace_count": 1,
    "migration.outcome": "completed",
  });
});
