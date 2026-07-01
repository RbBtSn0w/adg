import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import opentelemetry, { type Tracer } from "@opentelemetry/api";

const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const TELEMETRY_URL =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (baseEndpoint
    ? `${baseEndpoint.replace(/\/$/, "")}/v1/traces`
    : "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces");

function isEnabled(): boolean {
  return !process.env.DISABLE_TELEMETRY && !process.env.DO_NOT_TRACK;
}

let provider: NodeTracerProvider | null = null;
let activeTracer: Tracer | null = null;

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

export async function shutdownTelemetry(): Promise<void> {
  if (provider) {
    try {
      await provider.shutdown();
    } catch {
      // Silently fail - telemetry should never break CLI exit
    }
  }
}

export function sanitizeArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (
      arg.startsWith("ghp_") ||
      arg.startsWith("gho_") ||
      arg.startsWith("ghu_") ||
      arg.startsWith("ghs_") ||
      arg.startsWith("ghr_") ||
      arg.startsWith("github_pat_")
    ) {
      return "[REDACTED_TOKEN]";
    }
    if (arg.includes("@") && (arg.startsWith("http://") || arg.startsWith("https://"))) {
      try {
        const url = new URL(arg);
        if (url.username) {
          url.username = "[REDACTED]";
        }
        if (url.password) {
          url.password = "[REDACTED]";
        }
        return url.toString();
      } catch {
        return "[REDACTED_URL]";
      }
    }
    return arg;
  });
}
