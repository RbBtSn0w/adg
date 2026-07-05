import { test } from "node:test";
import assert from "node:assert/strict";

import { collectIssues, validateManifest, ManifestError } from "../src/manifest.ts";
import { baseManifest } from "./helpers.ts";

test("validateManifest accepts a valid manifest", () => {
  assert.doesNotThrow(() => validateManifest(baseManifest));
});

test("collectIssues flags bad name, version, schemaVersion", () => {
  const issues = collectIssues({ schemaVersion: "x", name: "Bad_Name", version: "1.0", description: "" });
  assert.ok(issues.some((i) => i.includes("schemaVersion")));
  assert.ok(issues.some((i) => i.includes("kebab-case")));
  assert.ok(issues.some((i) => i.includes("semantic")));
  assert.ok(issues.some((i) => i.includes("description")));
});

test("collectIssues rejects the removed mcp manifest field", () => {
  const issues = collectIssues({ ...baseManifest, mcp: "./.mcp.json" });
  assert.ok(issues.some((i) => i.includes("use mcpServers")));
});

test("collectIssues rejects component paths that escape the plugin directory", () => {
  const issues = collectIssues({
    ...baseManifest,
    skills: "../skills",
    hooks: "/tmp/hooks.json",
  });
  assert.ok(issues.includes("skills must stay within the plugin directory"));
  assert.ok(issues.includes("hooks must stay within the plugin directory"));
});

test("collectIssues rejects Windows drive-relative component paths", () => {
  const issues = collectIssues({ ...baseManifest, skills: "C:skills" });
  assert.ok(issues.includes("skills must stay within the plugin directory"));
});

test("validateManifest throws ManifestError with issues", () => {
  assert.throws(() => validateManifest({}), (err: unknown) => err instanceof ManifestError);
});
