import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import opentelemetry, { type Tracer, propagation, ROOT_CONTEXT } from "@opentelemetry/api";

const TELEMETRY_URL =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces";
const AUDIT_URL = "https://add-skill.vercel.sh/audit";

interface InstallTelemetryData {
  event: "install";
  source: string;
  skills: string;
  agents: string;
  global?: "1";
  skillFiles?: string;
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

export type TelemetryData =
  | InstallTelemetryData
  | RemoveTelemetryData
  | UpdateTelemetryData
  | FindTelemetryData
  | SyncTelemetryData;

let cliVersion: string | null = null;
let detectedAgentName: string | null = null;
let provider: NodeTracerProvider | null = null;
let activeTracer: Tracer | null = null;

function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.BUILDKITE ||
    process.env.JENKINS_URL ||
    process.env.TEAMCITY_VERSION
  );
}

function isEnabled(): boolean {
  return !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK;
}

export function setDetectedAgent(agentName: string | null): void {
  detectedAgentName = agentName;
}

export function setVersion(version: string): void {
  cliVersion = version;
}

export interface PartnerAudit {
  risk: "safe" | "low" | "medium" | "high" | "critical" | "unknown";
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

export type SkillAuditData = Record<string, PartnerAudit>;
export type AuditResponse = Record<string, SkillAuditData>;

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
  if (!activeTracer) {
    provider = new NodeTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: "adg",
      }),
    });

    const exporter = new OTLPTraceExporter({
      url: TELEMETRY_URL,
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
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
