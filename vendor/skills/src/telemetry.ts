import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import * as opentelemetry from "@opentelemetry/api";
import { type Tracer, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const TELEMETRY_URL =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (baseEndpoint
    ? `${baseEndpoint.replace(/\/$/, "")}/v1/traces`
    : "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces");

const AUDIT_URL = "https://add-skill.vercel.sh/audit";

interface InstallTelemetryData {
  event: "install";
  source: string;
  skills: string;
  agents: string;
  global?: "1";
  skillFiles?: string; // JSON stringified { skillName: relativePath }
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

let provider: NodeTracerProvider | null = null;
let activeTracer: Tracer | null = null;
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
  if (!isEnabled()) {
    return opentelemetry.trace.getTracer("adg-noop");
  }
  if (!activeTracer) {
    const exporter = new OTLPTraceExporter({
      url: TELEMETRY_URL,
    });

    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: "adg",
      }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    provider.register();

    activeTracer = opentelemetry.trace.getTracer("adg");
  }
  return activeTracer;
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
    if (detectedAgentName) {
      span.setAttribute("agent", detectedAgentName);
    }

    // Set event attributes
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        span.setAttribute(key, String(value));
      }
    }

    span.end();
  } catch {
    // Silently fail - telemetry should never break the CLI
  }
}

export async function flushTelemetry(timeoutMs = 5000): Promise<void> {
  if (provider) {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([provider.shutdown(), timeout]);
  }
}
