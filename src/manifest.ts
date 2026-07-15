import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Span } from "@opentelemetry/api";
import { ADG_SCHEMA_VERSION, COMPONENT_TYPES, type AdgManifest } from "./types.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import { probeDefaultDsl } from "./default-dsl.ts";

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
const MANIFEST_FIELDS = new Set([
  "schemaVersion", "name", "version", "description", "author", "license", "category",
  "interface", "skills", "agents", "commands", "apps", "hooks", "mcpServers",
  "dependencies", "selectionDependencies", "strict", "homepage", "changelog",
]);

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
    // A repository manifest is an explicit mapping only for fields it names.
    // Standard skills/hooks/MCP locations remain the default DSL for omitted
    // component fields, keeping source authors from repeating boilerplate.
    if (typeof m.name === "string" && typeof m.description === "string") {
      try {
        const ignored = new Set<"skills" | "hooks" | "mcp">();
        if (m.skills !== undefined) ignored.add("skills");
        if (m.hooks !== undefined) ignored.add("hooks");
        if (m.mcpServers !== undefined) ignored.add("mcp");
        const defaults = probeDefaultDsl(pluginDir, { ignore: ignored }).manifest;
        for (const key of ["skills", "hooks", "mcpServers"] as const) {
          if (m[key] === undefined && defaults[key] !== undefined) m[key] = defaults[key];
        }
      } catch (error) {
        // A manifest may use entirely custom locations and therefore have no
        // conventional component. Any malformed conventional component that it
        // *inherits*, however, is a source error and must never be hidden.
        if (!(error instanceof Error) || !error.message.includes("no default plugin component")) throw error;
      }
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

  for (const key of Object.keys(m)) {
    if (!MANIFEST_FIELDS.has(key)) issues.push(`unsupported manifest field: ${key}`);
  }

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

  if (m.author !== undefined) {
    if (!isRecord(m.author)) {
      issues.push("author must be an object");
    } else {
      for (const key of Object.keys(m.author)) {
        if (!["name", "url", "email"].includes(key)) issues.push(`author contains unsupported field: ${key}`);
      }
      if (typeof m.author.name !== "string") issues.push("author.name must be a string");
      for (const key of ["url", "email"] as const) {
        if (m.author[key] !== undefined && typeof m.author[key] !== "string") issues.push(`author.${key} must be a string`);
      }
    }
  }
  if (m.interface !== undefined) {
    if (!isRecord(m.interface)) {
      issues.push("interface must be an object");
    } else {
      for (const key of ["displayName", "shortDescription", "icon"] as const) {
        if (m.interface[key] !== undefined && typeof m.interface[key] !== "string") issues.push(`interface.${key} must be a string`);
      }
    }
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
        if (!isRecord(dep)) {
          issues.push(`dependencies[${i}] must be an object`);
          return;
        }
        const d = dep;
        for (const key of Object.keys(d)) {
          if (!["name", "version"].includes(key)) issues.push(`dependencies[${i}] contains unsupported field: ${key}`);
        }
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
        for (const key of Object.keys(requirement)) {
          if (!["components", "skills"].includes(key)) {
            issues.push(`selectionDependencies.${component} contains unsupported field: ${key}`);
          }
        }
        if (requirement.components !== undefined && (!isStringArray(requirement.components)
          || requirement.components.some((value) => !COMPONENT_TYPES.includes(value as (typeof COMPONENT_TYPES)[number])))) {
          issues.push(`selectionDependencies.${component}.components must contain supported component names`);
        } else if (isStringArray(requirement.components) && new Set(requirement.components).size !== requirement.components.length) {
          issues.push(`selectionDependencies.${component}.components must not contain duplicates`);
        }
        if (requirement.skills !== undefined && !isStringArray(requirement.skills)) {
          issues.push(`selectionDependencies.${component}.skills must be an array of strings`);
        } else if (isStringArray(requirement.skills) && new Set(requirement.skills).size !== requirement.skills.length) {
          issues.push(`selectionDependencies.${component}.skills must not contain duplicates`);
        }
      }
    }
  }
  return issues;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePointer(value: string): boolean {
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value)) return false;
  return !value.replaceAll("\\", "/").split("/").includes("..");
}
