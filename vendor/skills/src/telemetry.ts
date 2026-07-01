import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import opentelemetry, { type Tracer, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const TELEMETRY_URL =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (baseEndpoint
    ? `${baseEndpoint.replace(/\/$/, "")}/v1/traces`
    : "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces");

interface InstallTelemetryData {
  event: "install";
  source: string;
  skills: string;
  agents: string;
  global?: "1";
  skillFiles?: string;
}

interface UpdateTelemetryData {
  event: "update";
  successCount: number;
  failCount: number;
  checkedCount: number;
  global?: "1";
}

interface RemoveTelemetryData {
  event: "remove";
  skill: string;
  global?: "1";
}

type TelemetryData = InstallTelemetryData | UpdateTelemetryData | RemoveTelemetryData;

let provider: NodeTracerProvider | null = null;
let activeTracer: Tracer | null = null;
let detectedAgentName: string | null = null;

export function setDetectedAgent(agentName: string | null): void {
  detectedAgentName = agentName;
}

function isEnabled(): boolean {
  return !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK;
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
    const up = self.endsWith(".ts") ? ".." : join("..", "..");
    const pkgPath = join(here, up, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version;
  } catch {
    return null;
  }
}

const cliVersion = getCliVersion();

async function auditSkill(url: string, source: string): Promise<string | null> {
  if (!isEnabled()) return null;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `skills-cli/${cliVersion || "unknown"}`,
      },
      body: JSON.stringify({ source }),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { warning?: string };
    return data.warning || null;
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
