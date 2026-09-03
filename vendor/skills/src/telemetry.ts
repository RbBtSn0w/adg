import { type Tracer, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTracer as getAdgTracer, shutdownTelemetry } from "../../../src/telemetry.ts";

const AUDIT_URL = "https://add-skill.vercel.sh/audit";

interface InstallTelemetryData {
  event: "install";
  source: string;
  skills: string;
  agents: string;
  global?: "1";
  skillFiles?: string; // JSON stringified { skillName: relativePath }
  installUrl?: string;
  sourceType?: string;
}

interface RemoveTelemetryData {
  event: "remove";
  source?: string;
  skills: string;
  agents: string;
  global?: "1";
  sourceType?: string;
}

interface UpdateTelemetryData {
  event: "update";
  scope?: string;
  skillCount: string;
  successCount: string;
  failCount: string;
}

interface FindTelemetryData {
  event: "find";
  query: string;
  resultCount: string;
  interactive?: "1";
}

interface SyncTelemetryData {
  event: "experimental_sync";
  skillCount: string;
  successCount: string;
  agents: string;
}

type TelemetryData =
  | InstallTelemetryData
  | RemoveTelemetryData
  | UpdateTelemetryData
  | FindTelemetryData
  | SyncTelemetryData;

let detectedAgentName: string | null = null;

export function setDetectedAgent(agentName: string | null): void {
  detectedAgentName = agentName;
}

function isEnabled(): boolean {
  return (
    !process.env.DISABLE_TELEMETRY &&
    !process.env.DO_NOT_TRACK &&
    !process.env.NODE_TEST_CONTEXT
  );
}

function isCI(): boolean {
  return (
    process.env.CI === "true" ||
    process.env.CI === "1" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.VERCEL === "1"
  );
}

function getCliVersion(): string | null {
  try {
    const self = fileURLToPath(import.meta.url);
    const here = dirname(self);
    // Resolve adg's top-level package.json (name "@rbbtsn0w/adg"), not the
    // vendored skills-cli package.json. This module lives at
    // vendor/skills/src/telemetry.ts (dev) or dist/vendor/skills/src/
    // telemetry.js (built), so the adg root is 3 levels up for .ts, 4 for .js.
    const up = self.endsWith(".ts")
      ? join("..", "..", "..")
      : join("..", "..", "..", "..");
    const pkgPath = join(here, up, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return null;
  }
}

const cliVersion = getCliVersion();

// ─── Security audit data ───

export interface PartnerAudit {
  risk: "safe" | "low" | "medium" | "high" | "critical" | "unknown";
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

export type SkillAuditData = Record<string, PartnerAudit>;
export type AuditResponse = Record<string, SkillAuditData>;

/**
 * Fetch security audit results for skills from the audit API.
 * Returns null on any error or timeout — never blocks installation.
 */
export async function fetchAuditData(
  source: string,
  skillSlugs: string[],
  timeoutMs = 3000
): Promise<AuditResponse | null> {
  if (skillSlugs.length === 0) return null;

  try {
    const params = new URLSearchParams({
      source,
      skills: skillSlugs.join(","),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${AUDIT_URL}?${params.toString()}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    return (await response.json()) as AuditResponse;
  } catch {
    return null;
  }
}

export function getTracer(): Tracer {
  return getAdgTracer();
}

export function track(data: TelemetryData): void {
  if (!isEnabled()) return;

  try {
    const tracer = getTracer();
    const parentContext = propagation.extract(ROOT_CONTEXT, process.env);
    const span = tracer.startSpan(`skills-${data.event}`, {}, parentContext);

    // Set common attributes
    span.setAttribute("domain", "skills");
    if (cliVersion) {
      span.setAttribute("cli.version", cliVersion);
    }
    if (isCI()) {
      span.setAttribute("ci", true);
    }
    if (detectedAgentName) span.setAttribute("adg.command.target", detectedAgentName);
    span.setAttribute("adg.skills.operation", data.event);
    if ("sourceType" in data && data.sourceType) span.setAttribute("adg.source.type", data.sourceType);
    if ("global" in data) span.setAttribute("adg.command.scope", data.global === "1" ? "global" : "project");
    if ("scope" in data && data.scope) span.setAttribute("adg.command.scope", data.scope);
    if ("skillCount" in data) span.setAttribute("adg.skills.count", Number(data.skillCount));
    if ("successCount" in data) span.setAttribute("adg.skills.success_count", Number(data.successCount));
    if ("failCount" in data) span.setAttribute("adg.skills.failed_count", Number(data.failCount));
    if ("resultCount" in data) span.setAttribute("adg.skills.result_count", Number(data.resultCount));
    if ("interactive" in data) span.setAttribute("adg.command.interactive", data.interactive === "1");

    span.end();
  } catch {
    // Silently fail - telemetry should never break the CLI
  }
}

export async function flushTelemetry(timeoutMs = 5000): Promise<void> {
  await shutdownTelemetry(Math.min(timeoutMs, 1500));
}
