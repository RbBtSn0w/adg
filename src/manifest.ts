import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Span } from "@opentelemetry/api";
import { ADG_SCHEMA_VERSION, COMPONENT_TYPES, type AdgManifest } from "./types.ts";
import { recordTelemetryEvent } from "./telemetry.ts";

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
export function readManifest(pluginDir: string, telemetrySpan?: Pick<Span, "addEvent">): AdgManifest {
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
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    if (!m.mcpServers && existsSync(join(pluginDir, ".mcp.json"))) {
      m.mcpServers = "./.mcp.json";
    }
    const schemaVersion = m.schemaVersion;
    if (typeof schemaVersion === "string") {
      recordTelemetryEvent("adg.manifest.read", {
        "schema.version": schemaVersion === ADG_SCHEMA_VERSION ? schemaVersion : "other",
        "manifest.layout": file === join(pluginDir, LEGACY_MANIFEST_PATH) ? "legacy" : "canonical",
      }, telemetrySpan);
    }
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
  if (typeof m.skills === "string" && !isSafeRelativePointer(m.skills)) issues.push("skills must stay within the plugin directory");
  if (isStringArray(m.skills) && m.skills.some((path) => !isSafeRelativePointer(path))) {
    issues.push("skills entries must stay within the plugin directory");
  }
  if (m.mcp !== undefined) {
    issues.push("mcp is not supported; use mcpServers");
  }
  for (const key of ["agents", "commands", "apps", "hooks", "mcpServers", "homepage", "changelog", "license", "category"]) {
    if (m[key] !== undefined && typeof m[key] !== "string") {
      issues.push(`${key} must be a string`);
    }
    if (typeof m[key] === "string" && ["agents", "commands", "apps", "hooks", "mcpServers"].includes(key)
      && !isSafeRelativePointer(m[key] as string)) {
      issues.push(`${key} must stay within the plugin directory`);
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
  if (m.selectionDependencies !== undefined) {
    if (typeof m.selectionDependencies !== "object" || m.selectionDependencies === null || Array.isArray(m.selectionDependencies)) {
      issues.push("selectionDependencies must be an object");
    } else {
      for (const [component, rawRequirement] of Object.entries(m.selectionDependencies as Record<string, unknown>)) {
        if (!COMPONENT_TYPES.includes(component as (typeof COMPONENT_TYPES)[number])) {
          issues.push(`selectionDependencies.${component} is not a supported component`);
          continue;
        }
        if (typeof rawRequirement !== "object" || rawRequirement === null || Array.isArray(rawRequirement)) {
          issues.push(`selectionDependencies.${component} must be an object`);
          continue;
        }
        const requirement = rawRequirement as Record<string, unknown>;
        if (requirement.components !== undefined && (!isStringArray(requirement.components)
          || requirement.components.some((value) => !COMPONENT_TYPES.includes(value as (typeof COMPONENT_TYPES)[number])))) {
          issues.push(`selectionDependencies.${component}.components must contain supported component names`);
        }
        if (requirement.skills !== undefined && !isStringArray(requirement.skills)) {
          issues.push(`selectionDependencies.${component}.skills must be an array of strings`);
        }
      }
    }
  }
  // `adapters` is no longer part of the DSL. A stray one from an old manifest is
  // tolerated (ignored) rather than rejected — output paths are ADG-internal.
  return issues;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isSafeRelativePointer(value: string): boolean {
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}
