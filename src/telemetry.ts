import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import * as opentelemetry from "@opentelemetry/api";
import { type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeTraceEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = path.endsWith("/v1/traces")
      ? path
      : `${path}/v1/traces`;
    return url.toString();
  } catch {
    const normalized = endpoint.replace(/\/+$/, "");
    return normalized.endsWith("/v1/traces") ? normalized : `${normalized}/v1/traces`;
  }
}

const DEFAULT_TRACE_ENDPOINT = "https://telemetry-gateway.hamiltonsnow.workers.dev/v1/traces";
const GATEWAY_ORIGINS = new Set([
  "https://telemetry-gateway-development.hamiltonsnow.workers.dev",
  "https://telemetry-gateway-staging.hamiltonsnow.workers.dev",
  "https://telemetry-gateway.hamiltonsnow.workers.dev",
]);
const GATEWAY_PROFILE = "anonymous-client-v1";
const OTLP_HEADER_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
] as const;

function gatewayHeaders(endpoint: string): Record<string, string> {
  try {
    return GATEWAY_ORIGINS.has(new URL(endpoint).origin)
      ? { "otel-gateway-profile": GATEWAY_PROFILE }
      : {};
  } catch {
    return {};
  }
}

export interface TelemetryConfig {
  enabled: boolean;
  traceEndpoint: string;
  headers: Record<string, string>;
  batch: {
    maxQueueSize: number;
    maxExportBatchSize: number;
    scheduledDelayMillis: number;
    exportTimeoutMillis: number;
  };
  exporterTimeoutMillis: number;
  shutdownTimeoutMillis: number;
}

export function withoutAmbientOtlpHeaders<T>(operation: () => T): T {
  const previous = OTLP_HEADER_ENV_KEYS.map((key) => ({
    key,
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }));
  for (const { key } of previous) delete process.env[key];
  try {
    return operation();
  } finally {
    for (const { key, present, value } of previous) {
      if (present && value !== undefined) process.env[key] = value;
      else delete process.env[key];
    }
  }
}

export function defaultTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const explicitTraceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const explicitBaseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return {
    enabled:
      env.OTEL_SDK_DISABLED?.toLowerCase() !== "true" &&
      !env.DISABLE_TELEMETRY &&
      !env.DO_NOT_TRACK &&
      !env.NODE_TEST_CONTEXT,
    traceEndpoint:
      explicitTraceEndpoint ??
      (explicitBaseEndpoint ? normalizeTraceEndpoint(explicitBaseEndpoint) : DEFAULT_TRACE_ENDPOINT),
    headers: gatewayHeaders(
      explicitTraceEndpoint ??
      (explicitBaseEndpoint ? normalizeTraceEndpoint(explicitBaseEndpoint) : DEFAULT_TRACE_ENDPOINT),
    ),
    batch: {
      maxQueueSize: 256,
      maxExportBatchSize: 64,
      scheduledDelayMillis: 100,
      exportTimeoutMillis: 1000,
    },
    exporterTimeoutMillis: 1000,
    shutdownTimeoutMillis: 1500,
  };
}

function isEnabled(): boolean {
  return defaultTelemetryConfig(process.env).enabled;
}

let provider: NodeTracerProvider | null = null;
let activeTracer: Tracer | null = null;

function serviceVersion(): string {
  try {
    const self = fileURLToPath(import.meta.url);
    const root = self.endsWith(".ts") ? join(dirname(self), "..") : join(dirname(self), "..", "..");
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export function getTracer(): Tracer {
  if (!isEnabled()) {
    return opentelemetry.trace.getTracer("adg-noop");
  }

  if (!activeTracer) {
    const config = defaultTelemetryConfig(process.env);
    const createExporter = () => new OTLPTraceExporter({
      url: config.traceEndpoint,
      headers: config.headers,
      timeoutMillis: config.exporterTimeoutMillis,
    });
    // The Node exporter merges ambient OTLP header env vars even when explicit
    // headers are supplied. Suppress them only for the managed gateway so a
    // local vendor credential cannot ride along with the admission profile.
    const exporter = Object.keys(config.headers).length > 0
      ? withoutAmbientOtlpHeaders(createExporter)
      : createExporter();

    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: "adg",
        [SemanticResourceAttributes.SERVICE_NAMESPACE]: "com.rbbtsn0w",
        [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion(),
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, config.batch)],
    });

    provider.register();

    activeTracer = opentelemetry.trace.getTracer("adg");
  }

  return activeTracer;
}

export async function shutdownTelemetry(
  timeoutMillis = defaultTelemetryConfig(process.env).shutdownTimeoutMillis,
): Promise<void> {
  if (provider) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        provider.shutdown(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMillis);
        }),
      ]);
    } catch {
      // Silently fail - telemetry should never break CLI exit
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
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
  const [executableName, ...rest] = args;
  const safePositionals: ReadonlySet<string> =
    executableName === "adg"
      ? new Set(["plugin", "plugins", "skill", "skills", "update", "add", "remove", "sync", "list", "status", "inspect", "validate", "migrate", "cache", "marketplace", "link", "unlink", "enable", "disable", "import-skills"])
      : executableName === "git"
        ? new Set(["clone", "fetch", "pull", "rev-parse", "ls-remote", "show", "init", "add", "commit", "sparse-checkout"])
        : executableName === "npm"
          ? new Set(["install", "update", "exec"])
          : new Set();
  const optionsWithValues: ReadonlySet<string> =
    executableName === "git"
      ? new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"])
      : executableName === "npm"
        ? new Set(["--prefix", "--workspace", "-w", "--userconfig", "--cache", "--registry"])
        : new Set();
  let commandPositionFound = false;
  let optionValueExpected = false;
  return [executableName ?? "", ...rest.map((arg, index) => {
    if (arg.startsWith("-")) {
      if (!commandPositionFound && !arg.includes("=") && optionsWithValues.has(arg)) {
        optionValueExpected = true;
      }
      return arg.includes("=") ? "[FLAG]=[VALUE]" : "[FLAG]";
    }
    if (optionValueExpected) {
      optionValueExpected = false;
      return "[VALUE]";
    }
    const positionIsStructural =
      (executableName === "adg" && index <= 1) ||
      ((executableName === "git" || executableName === "npm") && !commandPositionFound);
    if (executableName === "git" || executableName === "npm") {
      commandPositionFound = true;
    }
    if (positionIsStructural && safePositionals.has(arg)) {
      return arg;
    }
    return "[VALUE]";
  })];
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
