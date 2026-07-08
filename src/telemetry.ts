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
    const trimmed = path.replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[\\/]+/);
    const base = parts[parts.length - 1] || "";

    if (trimmed.startsWith("~")) {
      if (trimmed === "~") return "~";
      return `~/${base}`;
    }

    const home = homedir();
    if (home) {
      const normalizedHome = home.replace(/[\\/]+$/, "");
      if (trimmed === normalizedHome) return "~";
      const prefix = `${normalizedHome}/`;
      const prefixWin = `${normalizedHome}\\`;
      if (trimmed.startsWith(prefix) || trimmed.startsWith(prefixWin)) {
        return `~/${base}`;
      }
    }

    const temp = tmpdir();
    if (temp) {
      const normalizedTemp = temp.replace(/[\\/]+$/, "");
      if (trimmed === normalizedTemp) return "[TMP]";
      const prefix = `${normalizedTemp}/`;
      const prefixWin = `${normalizedTemp}\\`;
      if (trimmed.startsWith(prefix) || trimmed.startsWith(prefixWin)) {
        return `[TMP]/${base}`;
      }
    }

    if (isAbsolute(trimmed)) {
      return `[REDACTED_PATH]/${base}`;
    }

    if (trimmed.includes("/") || trimmed.includes("\\")) {
      return `[REDACTED_PATH]/${base}`;
    }
    return trimmed;
  } catch {
    return "[REDACTED_PATH]";
  }
}

function sanitizeSingleValue(val: string, isAfterC: boolean = false): string {
  if (
    val.startsWith("ghp_") ||
    val.startsWith("gho_") ||
    val.startsWith("ghu_") ||
    val.startsWith("ghs_") ||
    val.startsWith("ghr_") ||
    val.startsWith("github_pat_")
  ) {
    return "[REDACTED_TOKEN]";
  }
  if (val.includes("@") && (val.startsWith("http://") || val.startsWith("https://"))) {
    try {
      const url = new URL(val);
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
  if (isAfterC) {
    return sanitizePath(val);
  }
  if (
    (isAbsolute(val) || val.startsWith("~") || val.includes("/") || val.includes("\\")) &&
    !val.startsWith("http://") &&
    !val.startsWith("https://")
  ) {
    return sanitizePath(val);
  }
  return val;
}

export function sanitizeArgs(args: string[]): string[] {
  let prevArg = "";
  return args.map((arg) => {
    let sanitized = arg;
    if (arg.startsWith("-")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        const flag = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        const isAfterC = flag === "-C";
        sanitized = `${flag}=${sanitizeSingleValue(value, isAfterC)}`;
      }
    } else {
      const isAfterC = prevArg === "-C";
      sanitized = sanitizeSingleValue(arg, isAfterC);
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
