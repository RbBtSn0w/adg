import { test } from "node:test";
import assert from "node:assert/strict";

import { parseClaudePluginList } from "../src/agents/claude.ts";
import { parseCodexPluginList } from "../src/agents/codex.ts";
import { parseAntigravityPluginList } from "../src/agents/antigravity.ts";

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

// ---- Codex: a `<name>@mp  STATUS  VERSION  PATH` table ----

const CODEX_OUT = `Marketplace \`plugins\`
/Users/snow/.agents/plugins/marketplace.json

PLUGIN                STATUS              VERSION  PATH
apple-skills@plugins  installed, enabled  1.12.0   /Users/snow/.agents/plugins/x/apple-skills
asc@plugins           installed, enabled  0.1.0    /Users/snow/.agents/plugins/y/asc
muted@plugins         installed, disabled 2.0.0    /Users/snow/.agents/plugins/x/muted
later@plugins         available           3.0.0    /Users/snow/.agents/plugins/x/later
foo@othermp           installed, enabled  1.0.0    /Users/snow/.agents/plugins/z/foo
`;

test("parseCodexPluginList keeps only installed+enabled rows of the given marketplace", () => {
  // muted is disabled and later is merely available — both excluded; foo is in
  // a different marketplace.
  assert.deepEqual(parseCodexPluginList(CODEX_OUT, "plugins"), ["apple-skills", "asc"]);
});

test("parseCodexPluginList skips the header, banner, and path lines (no false matches)", () => {
  // "PLUGIN", the marketplace banner, and absolute paths have no `name@mp` token.
  assert.deepEqual(parseCodexPluginList(CODEX_OUT, "othermp"), ["foo"]);
});

// ---- Antigravity: `{ imports: [{ name }] }` JSON ----

test("parseAntigravityPluginList extracts and dedupes import names", () => {
  const out = JSON.stringify({ imports: [{ name: "asc" }, { name: "asc" }, { name: "design" }, { name: 123 }] });
  assert.deepEqual(parseAntigravityPluginList(out), ["asc", "design"]);
});

test("parseAntigravityPluginList returns undefined for non-JSON output", () => {
  assert.equal(parseAntigravityPluginList("agy: command failed"), undefined);
});

test("parseAntigravityPluginList tolerates a missing imports array", () => {
  assert.deepEqual(parseAntigravityPluginList("{}"), []);
});
