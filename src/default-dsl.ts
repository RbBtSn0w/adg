import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ADG_SCHEMA_VERSION, type AdgManifest } from "./types.ts";
import { readSkillDescription } from "./skills.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import type { Span } from "@opentelemetry/api";

export interface DefaultDslMetadata { name: string; description: string; }
export interface DefaultDslResult { manifest: AdgManifest; components: Array<"skills" | "hooks" | "mcp">; fingerprint: string; }
export interface DefaultDslOptions {
  ignore?: ReadonlySet<"skills" | "hooks" | "mcp">;
  telemetrySpan?: Pick<Span, "addEvent">;
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
  const ignore = options.ignore ?? new Set<"skills" | "hooks" | "mcp">();
  const skillsRoot = join(root, "skills");
  const skillFiles = !ignore.has("skills") && existsSync(skillsRoot) && statSync(skillsRoot).isDirectory()
    ? readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md"))).map((entry) => join(skillsRoot, entry.name, "SKILL.md"))
    : [];
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
  const hasher = createHash("sha256").update(JSON.stringify({ metadata, components }));
  if (hasSkills) hashTree(hasher, skillsRoot, "skills");
  if (hasHooks) hashTree(hasher, join(root, "hooks"), "hooks");
  if (hasMcp) hasher.update(".mcp.json\0").update(readFileSync(mcpFile));
  const fingerprint = hasher.digest("hex");
  recordTelemetryEvent("adg.default_dsl.resolve", {
    "definition.kind": "default-dsl/v1",
    "components.count": components.length,
    outcome: "success",
  }, options.telemetrySpan);
  return {
    components,
    fingerprint,
    manifest: {
      schemaVersion: ADG_SCHEMA_VERSION,
      name: defaultPluginName(metadata.name),
      version: `0.0.0-adg.${fingerprint}`,
      description: metadata.description,
      ...(hasSkills ? { skills: "./skills/" } : { skills: [] }),
      ...(hasHooks ? { hooks: "./hooks/" } : {}),
      ...(hasMcp ? { mcpServers: "./.mcp.json" } : {}),
    },
  };
}

function validJson(file: string): boolean {
  if (!existsSync(file)) return false;
  try { JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; }
}

function validMcp(file: string): boolean {
  if (!validJson(file)) return false;
  const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (json === null || typeof json !== "object" || Array.isArray(json)) return false;
  const servers = (json as Record<string, unknown>).mcpServers ?? (json as Record<string, unknown>).servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers);
}

function hashTree(hasher: ReturnType<typeof createHash>, dir: string, rel: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(dir, entry.name);
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) hashTree(hasher, child, childRel);
    else if (entry.isFile()) hasher.update(childRel).update("\0").update(readFileSync(child));
  }
}
