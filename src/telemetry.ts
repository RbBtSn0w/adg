import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import * as opentelemetry from "@opentelemetry/api";
import { type Attributes, type Span, type Tracer } from "@opentelemetry/api";

const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
export function normalizeTraceEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/$/, "");
  return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
}

const TELEMETRY_URL =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (baseEndpoint
    ? normalizeTraceEndpoint(baseEndpoint)
    : "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces");

function isEnabled(): boolean {
  return (
    !process.env.DISABLE_TELEMETRY &&
    !process.env.DO_NOT_TRACK &&
    !process.env.NODE_TEST_CONTEXT
  );
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

/**
 * Unconditionally redact any non-empty string passed to it.
 * Telemetry consumers need the command skeleton (subcommands + flags),
 * not path details. Returning a fixed placeholder eliminates all
 * path-related privacy edge cases.
 */
export function sanitizePath(path: string | undefined): string {
  if (!path) return "";
  return "[PATH]";
}

export function sanitizeArgs(args: string[]): string[] {
  const tokenRegex = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)/i;
  return args.map((arg) => {
    if (arg.startsWith("-")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        return `${arg.slice(0, eqIndex)}=[VALUE]`;
      }
      if (arg.startsWith("--") && /^--[a-zA-Z0-9-]+$/.test(arg)) {
        return arg;
      }
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        if (/^-[a-zA-Z0-9]$/.test(arg)) {
          return arg;
        }
        if (/^-[a-zA-Z0-9]/.test(arg)) {
          return `${arg.slice(0, 2)}[VALUE]`;
        }
      }
      return "[VALUE]";
    }
    if (tokenRegex.test(arg)) {
      return "[VALUE]";
    }
    if (/^[a-zA-Z0-9_-]+$/.test(arg)) {
      return arg;
    }
    return "[VALUE]";
  });
}


/** Record a privacy-safe event without allowing telemetry to affect CLI behavior. */
export function recordTelemetryEvent(
  name: string,
  attributes: Attributes,
  span: Pick<Span, "addEvent"> | undefined = opentelemetry.trace.getActiveSpan(),
): void {
  try {
    span?.addEvent(name, attributes);
  } catch {
    // Telemetry must never change CLI behavior.
  }
}
