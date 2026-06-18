import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { getSkillLockPath } from "../vendor/skills/src/skill-lock.ts";
import { getAgentConfig } from "../vendor/skills/src/agents.ts";

/**
 * Guards the `.agents/` core invariant against a future re-vendor of the
 * skills fork silently dropping our local patches (see docs/agents-spec.md §1 and
 * vendor/skills/PROVENANCE.md → Local patches). Both the global skill lock and
 * the universal global skills dir MUST resolve under a single `.agents/` home
 * (`$XDG_STATE_HOME/.agents` if set, else `~/.agents`) — never upstream's
 * `$XDG_CONFIG_HOME/agents/...` or `$XDG_STATE_HOME/skills/...`.
 */

test("global skill lock resolves under .agents/ in both home and XDG modes", () => {
  const saved = process.env.XDG_STATE_HOME;
  try {
    delete process.env.XDG_STATE_HOME;
    assert.equal(getSkillLockPath(), join(homedir(), ".agents", ".skill-lock.json"));

    process.env.XDG_STATE_HOME = "/tmp/adg-xdg-state";
    assert.equal(getSkillLockPath(), join("/tmp/adg-xdg-state", ".agents", ".skill-lock.json"));
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
  }
});

test("universal agent shares the .agents/ home for global + project skills", () => {
  const universal = getAgentConfig("universal");
  // Project dir is upstream-correct and must stay the shared universal location.
  assert.equal(universal.skillsDir, ".agents/skills");
  // Global dir (import-time const; default/home env here) must mirror it under
  // .agents/, not upstream's $XDG_CONFIG_HOME/agents/skills.
  const globalDir = universal.globalSkillsDir;
  assert.ok(globalDir, "universal.globalSkillsDir must be set");
  assert.ok(
    globalDir.endsWith(join(".agents", "skills")),
    `universal.globalSkillsDir should end with .agents/skills, got ${globalDir}`,
  );
  assert.ok(
    !globalDir.includes(join(".config", "agents")),
    `universal.globalSkillsDir regressed to upstream .config path: ${globalDir}`,
  );
});
