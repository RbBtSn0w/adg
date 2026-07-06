import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claudeListFailure,
  parseClaudeMarketplaceList,
  parseClaudePluginList,
  parseClaudePluginListJson,
} from "../src/agents/claude.ts";
import { codexListFailure, codexUnrecognizedListFailure, parseCodexPluginList, parseCodexPluginListJson } from "../src/agents/codex.ts";

/**
 * The `listInstalled` parsers are the only place ADG reads each agent CLI's
 * free-form output, so they're guarded here against captured real samples —
 * the regex/JSON shapes a silent change could break.
 */

// ---- Claude: grouped `❯ name@mp` blocks with Scope/Status ----

const CLAUDE_OUT = `Installed plugins:

  ❯ apollo@adg
    Version: 0.1.0
    Scope: project
    Status: ✘ disabled

  ❯ apple-skills@adg
    Version: 1.12.0
    Scope: project
    Status: ✔ enabled

  ❯ apple-skills@adg
    Version: 1.12.0
    Scope: user
    Status: ✔ enabled

  ❯ other@somemarket
    Version: 1.0.0
    Scope: project
    Status: ✔ enabled
`;

test("parseClaudePluginList keeps enabled plugins of the given marketplace + scope", () => {
  // project: apple-skills enabled; apollo disabled and other@somemarket excluded.
  assert.deepEqual(parseClaudePluginList(CLAUDE_OUT, "adg", "project"), ["apple-skills"]);
});

test("parseClaudePluginList honors the install scope", () => {
  // user scope: the user-scoped apple-skills block only.
  assert.deepEqual(parseClaudePluginList(CLAUDE_OUT, "adg", "user"), ["apple-skills"]);
});

test("parseClaudePluginList excludes a disabled plugin", () => {
  // apollo is project-scoped but disabled, so it never appears.
  assert.ok(!parseClaudePluginList(CLAUDE_OUT, "adg", "project").includes("apollo"));
});

test("parseClaudePluginList returns nothing for an unknown marketplace", () => {
  assert.deepEqual(parseClaudePluginList(CLAUDE_OUT, "nope", "project"), []);
});

test("parseClaudePluginListJson keeps enabled plugins of the given marketplace + scope", () => {
  const out = JSON.stringify([
    { id: "apollo@adg", scope: "project", enabled: false },
    { id: "apple-skills@adg", scope: "project", enabled: true },
    { id: "apple-skills@adg", scope: "user", enabled: true },
    { id: "other@somemarket", scope: "project", enabled: true },
  ]);
  assert.deepEqual(parseClaudePluginListJson(out, "adg", "project"), ["apple-skills"]);
});

test("parseClaudePluginListJson returns undefined for invalid json", () => {
  assert.equal(parseClaudePluginListJson("not json", "adg", "project"), undefined);
});

test("parseClaudeMarketplaceList extracts marketplace names from json", () => {
  const out = JSON.stringify([
    { name: "adg", source: "directory" },
    { name: "claude-plugins-official", source: "github" },
    null,
    { source: "directory" },
  ]);
  assert.deepEqual(parseClaudeMarketplaceList(out), ["adg", "claude-plugins-official"]);
});

test("parseClaudeMarketplaceList returns an empty list for invalid json", () => {
  assert.deepEqual(parseClaudeMarketplaceList("not json"), []);
});

test("claudeListFailure reports unrecognized plugin-list output loudly", () => {
  const failure = claudeListFailure("Installed plugins:\n- not-json");
  assert.match(failure.error, /unrecognized/i);
  assert.match(failure.error, /Installed plugins/);
});

// ---- Codex: a `<name>@mp  STATUS  VERSION  PATH` table ----

const CODEX_OUT = `Marketplace \`plugins\`
/Users/snow/.agents/plugins/marketplace.json

PLUGIN                STATUS              VERSION  PATH
apple-skills@plugins  installed, enabled  1.12.0   /Users/snow/.agents/plugins/x/apple-skills
asc@plugins           installed, enabled  0.1.0    /Users/snow/.agents/plugins/y/asc
muted@plugins         installed, disabled 2.0.0    /Users/snow/.agents/plugins/x/muted
later@plugins         available           3.0.0    /Users/snow/.agents/plugins/x/later
removed@plugins       not installed                /Users/snow/.agents/plugins/x/removed
foo@othermp           installed, enabled  1.0.0    /Users/snow/.agents/plugins/z/foo
`;

test("parseCodexPluginList keeps only installed+enabled rows of the given marketplace", () => {
  // muted is disabled, later is merely available, and removed is explicitly not
  // installed — all are excluded; foo is in a different marketplace.
  assert.deepEqual(parseCodexPluginList(CODEX_OUT, "plugins"), ["apple-skills", "asc"]);
});

test("parseCodexPluginList skips the header, banner, and path lines (no false matches)", () => {
  // "PLUGIN", the marketplace banner, and absolute paths have no `name@mp` token.
  assert.deepEqual(parseCodexPluginList(CODEX_OUT, "othermp"), ["foo"]);
});

test("parseCodexPluginListJson keeps only installed+enabled entries of the given marketplace", () => {
  const out = JSON.stringify({
    installed: [
      { pluginId: "apple-skills@plugins", name: "apple-skills", marketplaceName: "plugins", installed: true, enabled: true },
      { pluginId: "asc@plugins", name: "asc", marketplaceName: "plugins", installed: true, enabled: true },
      { pluginId: "muted@plugins", name: "muted", marketplaceName: "plugins", installed: true, enabled: false },
      { pluginId: "foo@othermp", name: "foo", marketplaceName: "othermp", installed: true, enabled: true },
    ],
    available: [{ pluginId: "later@plugins", name: "later", marketplaceName: "plugins", installed: false, enabled: false }],
  });
  assert.deepEqual(parseCodexPluginListJson(out, "plugins"), ["apple-skills", "asc"]);
});

test("parseCodexPluginListJson returns undefined for invalid json", () => {
  assert.equal(parseCodexPluginListJson("not json", "plugins"), undefined);
});

test("codexListFailure offers cleanup for a stale ADG project marketplace", () => {
  const failure = codexListFailure(`Error: failed to load configured marketplace snapshot(s):
- \`adg-86bf8e7a\` at /tmp/project: marketplace root does not contain a supported manifest`);

  assert.match(failure.error, /adg-86bf8e7a/);
  assert.equal(failure.recoveryCommand, "codex plugin marketplace remove adg-86bf8e7a");
});

test("codexListFailure does not suggest deleting an unrecognized marketplace", () => {
  const failure = codexListFailure("Error: authentication failed");
  assert.equal(failure.error, "Error: authentication failed");
  assert.equal(failure.recoveryCommand, undefined);
});

test("codexUnrecognizedListFailure reports unrecognized plugin-list output loudly", () => {
  const failure = codexUnrecognizedListFailure("PLUGIN STATUS VERSION PATH");
  assert.match(failure.error, /PLUGIN STATUS VERSION PATH/);
});
