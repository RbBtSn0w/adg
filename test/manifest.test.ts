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

test("validateManifest throws ManifestError with issues", () => {
  assert.throws(() => validateManifest({}), (err: unknown) => err instanceof ManifestError);
});
