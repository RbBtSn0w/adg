import { homedir, tmpdir } from "node:os";
import { isAbsolute, basename } from "node:path";
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

export function sanitizePath(path: string | undefined): string {
  if (!path) return "";
  try {
    if (path.startsWith("~")) {
      if (path === "~") return "~";
      return `~/${basename(path)}`;
    }

    const home = homedir();
    if (home) {
      if (path === home) return "~";
      const normalizedHome = home.replace(/[\\/]+$/, "");
      const prefix = `${normalizedHome}/`;
      const prefixWin = `${normalizedHome}\\`;
      if (path.startsWith(prefix)) {
        return `~/${basename(path)}`;
      }
      if (path.startsWith(prefixWin)) {
        return `~/${basename(path)}`;
      }
    }

    const temp = tmpdir();
    if (temp) {
      if (path === temp) return "[TMP]";
      const normalizedTemp = temp.replace(/[\\/]+$/, "");
      const prefix = `${normalizedTemp}/`;
      const prefixWin = `${normalizedTemp}\\`;
      if (path.startsWith(prefix)) {
        return `[TMP]/${basename(path)}`;
      }
      if (path.startsWith(prefixWin)) {
        return `[TMP]/${basename(path)}`;
      }
    }

    if (isAbsolute(path)) {
      return `[REDACTED_PATH]/${basename(path)}`;
    }

    if (path.includes("/") || path.includes("\\")) {
      return `[REDACTED_PATH]/${basename(path)}`;
    }
  } catch {
    // Fail silently - telemetry should never break CLI behavior
  }
  return path;
}

export function sanitizeArgs(args: string[]): string[] {
  let prevArg = "";
  return args.map((arg) => {
    let sanitized = arg;
    if (
      arg.startsWith("ghp_") ||
      arg.startsWith("gho_") ||
      arg.startsWith("ghu_") ||
      arg.startsWith("ghs_") ||
      arg.startsWith("ghr_") ||
      arg.startsWith("github_pat_")
    ) {
      sanitized = "[REDACTED_TOKEN]";
    } else if (arg.includes("@") && (arg.startsWith("http://") || arg.startsWith("https://"))) {
      try {
        const url = new URL(arg);
        if (url.username) {
          url.username = "[REDACTED]";
        }
        if (url.password) {
          url.password = "[REDACTED]";
        }
        sanitized = url.toString();
      } catch {
        sanitized = "[REDACTED_URL]";
      }
    } else if (prevArg === "-C") {
      sanitized = sanitizePath(arg);
    } else if (
      (isAbsolute(arg) || arg.startsWith("~") || arg.includes("/") || arg.includes("\\")) &&
      !arg.startsWith("-") &&
      !arg.startsWith("http://") &&
      !arg.startsWith("https://")
    ) {
      sanitized = sanitizePath(arg);
    }
    prevArg = arg;
    return sanitized;
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
