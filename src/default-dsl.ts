import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "./types.ts";
import { readSkillDescription } from "./skills.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import type { Span } from "@opentelemetry/api";

export interface DefaultDslMetadata { name: string; description: string; }
export interface DefaultDslResult { manifest: AdgManifest; components: Array<"skills" | "hooks" | "mcp">; fingerprint: string; }
export interface DefaultDslOptions {
  ignore?: ReadonlySet<"skills" | "hooks" | "mcp">;
  /** Immutable Git revision for a remote structural source, when available. */
  resolvedRevision?: string;
  telemetrySpan?: Pick<Span, "addEvent">;
  recordTelemetry?: boolean;
}
export interface DefaultDslProbeResult {
  components: Array<"skills" | "hooks" | "mcp">;
  manifest: Pick<AdgManifest, "skills" | "hooks" | "mcpServers">;
}

/** Convert a repository directory name into the manifest's stable kebab-case identity. */
export function defaultPluginName(value: string): string {
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("default plugin name is empty");
  return normalized;
}

/**
 * Resolve the intentionally small structural DSL. It only recognizes the three
 * documented default locations; other directories are never guessed as runtime
 * components.
 */
export function resolveDefaultDsl(root: string, metadata: DefaultDslMetadata, options: DefaultDslOptions = {}): DefaultDslResult {
  const { components, manifest: componentManifest } = probeDefaultDsl(root, options);
  const hasSkills = components.includes("skills");
  const hasHooks = components.includes("hooks");
  const hasMcp = components.includes("mcp");
  const skillsRoot = join(root, "skills");
  const mcpFile = join(root, ".mcp.json");
  const hasher = createHash("sha256").update(JSON.stringify({ name: defaultPluginName(metadata.name), components }));
  if (hasSkills) hashTree(hasher, skillsRoot, "skills");
  if (hasHooks) hashTree(hasher, join(root, "hooks"), "hooks");
  if (hasMcp) hasher.update(".mcp.json\0").update(readFileSync(mcpFile)).update("\0");
  const fingerprint = hasher.digest("hex");
  if (options.recordTelemetry !== false) {
    recordTelemetryEvent("adg.default_dsl.resolve", {
      "definition.kind": "default-dsl/v1",
      "components.count": components.length,
      outcome: "success",
    }, options.telemetrySpan);
  }
  return {
    components,
    fingerprint,
    manifest: {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: defaultPluginName(metadata.name),
      version: options.resolvedRevision
        ? `0.0.0-git.${options.resolvedRevision}`
        : `0.0.0-adg.${fingerprint}`,
      description: metadata.description,
      ...componentManifest,
    },
  };
}

/** Discover and validate conventional component locations without hashing payload contents. */
export function probeDefaultDsl(root: string, options: Pick<DefaultDslOptions, "ignore"> = {}): DefaultDslProbeResult {
  const ignore = options.ignore ?? new Set<"skills" | "hooks" | "mcp">();
  const skillsRoot = join(root, "skills");
  const skillFiles = !ignore.has("skills") && isDirectory(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md"))).map((entry) => join(skillsRoot, entry.name, "SKILL.md"))
    : [];
  const invalidSkillFile = skillFiles.find((file) => !isRegularFile(file));
  if (invalidSkillFile) throw new Error(`invalid default skill file (must be a regular file): ${invalidSkillFile}`);
  const invalidSkill = skillFiles.find((file) => !readSkillDescription(file));
  if (invalidSkill) throw new Error(`default skill requires SKILL.md frontmatter with a description: ${invalidSkill}`);
  const hasSkills = skillFiles.length > 0;
  const hooksFile = join(root, "hooks", "hooks.json");
  const hasHooks = !ignore.has("hooks") && existsSync(hooksFile) && validJson(hooksFile);
  if (!ignore.has("hooks") && existsSync(hooksFile) && !hasHooks) throw new Error(`invalid default hooks configuration: ${hooksFile}`);
  const mcpFile = join(root, ".mcp.json");
  const hasMcp = !ignore.has("mcp") && existsSync(mcpFile) && validMcp(mcpFile);
  if (!ignore.has("mcp") && existsSync(mcpFile) && !hasMcp) throw new Error(`invalid default MCP configuration: ${mcpFile}`);
  const components: Array<"skills" | "hooks" | "mcp"> = [
    ...(hasSkills ? ["skills" as const] : []),
    ...(hasHooks ? ["hooks" as const] : []),
    ...(hasMcp ? ["mcp" as const] : []),
  ];
  if (components.length === 0) throw new Error(`no default plugin component found in ${root}`);
  return {
    components,
    manifest: {
      ...(hasSkills ? { skills: "./skills/" } : { skills: [] }),
      ...(hasHooks ? { hooks: "./hooks/" } : {}),
      ...(hasMcp ? { mcpServers: "./.mcp.json" } : {}),
    },
  };
}

function validJson(file: string): boolean {
  if (!isRegularFile(file)) return false;
  try { JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; }
}

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function validMcp(file: string): boolean {
  if (!validJson(file)) return false;
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  const servers = (json as Record<string, unknown>).mcpServers ?? (json as Record<string, unknown>).servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers);
}

function hashTree(hasher: ReturnType<typeof createHash>, dir: string, rel: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const child = join(dir, entry.name);
    const childRel = `${rel}/${entry.name}`;
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`default plugin component must not contain symlinks: ${child}`);
    if (stat.isDirectory()) hashTree(hasher, child, childRel);
    else if (stat.isFile()) hasher.update(childRel).update("\0").update(readFileSync(child)).update("\0");
  }
}
