import assert from "node:assert/strict";
import { runAdd } from "../../vendor/skills/src/add.ts";

// Terminal controls must not share node:test's serialized result transport.
assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
const directUrl = "https://raw.githubusercontent.com/example/skills/main/SKILL.md";
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
