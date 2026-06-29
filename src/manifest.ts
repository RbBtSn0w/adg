import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "./types.ts";

/** Canonical, vendor-neutral source manifest location (a plugin). */
export const ADG_MANIFEST_PATH = join(".agents", ".plugin.json");
/** Canonical, vendor-neutral source catalog location (a marketplace). */
export const ADG_MARKETPLACE_PATH = join(".agents", ".marketplace.json");
/** Legacy location, still read (deprecated) so pre-`.agents/` plugins resolve. */
export const LEGACY_MANIFEST_PATH = join(".adg-plugin", "plugin.json");

/**
 * Resolve a plugin's manifest file, preferring the canonical `.agents/.plugin.json`
 * and falling back to the legacy `.adg-plugin/plugin.json`. Returns undefined
 * when neither exists.
 */
export function findManifestFile(pluginDir: string): string | undefined {
  const primary = join(pluginDir, ADG_MANIFEST_PATH);
  if (existsSync(primary)) return primary;
  const legacy = join(pluginDir, LEGACY_MANIFEST_PATH);
  if (existsSync(legacy)) return legacy;
  return undefined;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export class ManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid ADG manifest:\n  - ${issues.join("\n  - ")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

/** Read and validate a plugin's `.agents/.plugin.json` (or legacy fallback). */
export function readManifest(pluginDir: string): AdgManifest {
  const file = findManifestFile(pluginDir);
  if (!file) {
    throw new ManifestError([`${ADG_MANIFEST_PATH} not found in ${pluginDir}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ManifestError([`${file} is not valid JSON: ${(err as Error).message}`]);
  }
  return validateManifest(raw);
}

/** Validate an already-parsed manifest object, throwing ManifestError on failure. */
export function validateManifest(raw: unknown): AdgManifest {
  const issues = collectIssues(raw);
  if (issues.length > 0) throw new ManifestError(issues);
  return raw as AdgManifest;
}

/** Collect validation issues without throwing (used by the `validate` command). */
export function collectIssues(raw: unknown): string[] {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["manifest must be a JSON object"];
  }
  const m = raw as Record<string, unknown>;

  if (m.schemaVersion !== ADG_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be "${ADG_SCHEMA_VERSION}"`);
  }
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    issues.push("name is required and must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)");
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    issues.push("version is required and must be semantic (e.g. 0.1.0)");
  }
  if (typeof m.description !== "string" || m.description.length === 0) {
    issues.push("description is required and must be a non-empty string");
  }

  if (m.skills !== undefined && typeof m.skills !== "string" && !isStringArray(m.skills)) {
    issues.push("skills must be a string or an array of strings");
  }
  if (m.mcp !== undefined) {
    issues.push("mcp is not supported; use mcpServers");
  }
  for (const key of ["agents", "commands", "apps", "hooks", "mcpServers", "homepage", "changelog", "license", "category"]) {
    if (m[key] !== undefined && typeof m[key] !== "string") {
      issues.push(`${key} must be a string`);
    }
  }
  if (m.strict !== undefined && typeof m.strict !== "boolean") {
    issues.push("strict must be a boolean");
  }
  if (m.dependencies !== undefined) {
    if (!Array.isArray(m.dependencies)) {
      issues.push("dependencies must be an array");
    } else {
      m.dependencies.forEach((dep, i) => {
        if (typeof dep !== "object" || dep === null) {
          issues.push(`dependencies[${i}] must be an object`);
          return;
        }
        const d = dep as Record<string, unknown>;
        if (typeof d.name !== "string") issues.push(`dependencies[${i}].name must be a string`);
        if (typeof d.version !== "string") issues.push(`dependencies[${i}].version must be a string`);
      });
    }
  }
  // `adapters` is no longer part of the DSL. A stray one from an old manifest is
  // tolerated (ignored) rather than rejected — output paths are ADG-internal.
  return issues;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
