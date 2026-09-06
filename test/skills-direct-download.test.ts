import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runAdd } from "../vendor/skills/src/add.ts";

test("skills add installs a hosted SKILL.md download without cloning", async () => {
  const project = await mkdtemp(join(tmpdir(), "adg-direct-download-"));
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  const originalTelemetry = process.env.DISABLE_TELEMETRY;
  const directUrl = "https://raw.githubusercontent.com/example/skills/main/SKILL.md";

  try {
    process.chdir(project);
    process.env.DISABLE_TELEMETRY = "1";
    globalThis.fetch = async (input) => {
      assert.equal(String(input), directUrl);
      return new Response(
        "---\nname: direct-download\ndescription: Direct download fixture\n---\n\n# Direct download\n",
        { status: 200 },
      );
    };

    await runAdd([directUrl], {
      agent: ["codex"],
      copy: true,
      global: false,
      yes: true,
    });

    const installed = await readFile(
      join(project, ".agents", "skills", "direct-download", "SKILL.md"),
      "utf8",
    );
    assert.match(installed, /# Direct download/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTelemetry === undefined) delete process.env.DISABLE_TELEMETRY;
    else process.env.DISABLE_TELEMETRY = originalTelemetry;
    process.chdir(originalCwd);
    await rm(project, { recursive: true, force: true });
  }
});
