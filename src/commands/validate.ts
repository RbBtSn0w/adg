import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADG_MANIFEST_PATH, collectIssues } from "../manifest.ts";

export interface ValidateResult {
  ok: boolean;
  issues: string[];
}

/**
 * Validate a plugin's manifest against the ADG schema and check that the
 * directories/files it references actually exist.
 */
export function validatePlugin(pluginDir: string): ValidateResult {
  const manifestFile = join(pluginDir, ADG_MANIFEST_PATH);
  if (!existsSync(manifestFile)) {
    return { ok: false, issues: [`${ADG_MANIFEST_PATH} not found in ${pluginDir}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (err) {
    return { ok: false, issues: [`${manifestFile} is not valid JSON: ${(err as Error).message}`] };
  }

  const issues = collectIssues(raw);
  if (issues.length > 0) return { ok: false, issues };

  // Reference checks (only when structural validation passed).
  const m = raw as Record<string, unknown>;
  const pathFields: Array<[string, unknown]> = [
    ["agents", m.agents],
    ["commands", m.commands],
    ["apps", m.apps],
    ["hooks", m.hooks],
    ["mcp", m.mcp],
  ];
  for (const [field, value] of pathFields) {
    if (typeof value === "string" && !existsSync(join(pluginDir, value))) {
      issues.push(`${field} points to "${value}" which does not exist`);
    }
  }

  if (typeof m.skills === "string") {
    if (!existsSync(join(pluginDir, m.skills))) {
      issues.push(`skills root "${m.skills}" does not exist`);
    }
  } else if (Array.isArray(m.skills)) {
    for (const s of m.skills as string[]) {
      if (!existsSync(join(pluginDir, s))) issues.push(`skill path "${s}" does not exist`);
    }
  }

  return { ok: issues.length === 0, issues };
}
