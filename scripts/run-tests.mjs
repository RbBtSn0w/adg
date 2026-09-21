import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";

const cacheHome = mkdtempSync(join(tmpdir(), "adg-test-cache-"));
// Tests spawn the real CLI, whose default telemetry endpoint is production. Route
// that synthetic traffic to the development gateway unless the caller overrides it.
const DEVELOPMENT_TRACES_ENDPOINT = "https://telemetry-gateway-development.hamiltonsnow.workers.dev/v1/traces";

try {
  // Keep Windows runs serial so file locks cannot hold temporary directories open
  // during async teardown. On other platforms, cap concurrency to prevent Node test runner
  // IPC buffer overflows.
  const concurrency = process.platform === "win32"
    ? 1
    : Math.min(availableParallelism?.() ?? 4, 4);
  const userArgs = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith("--test-concurrency=")) continue;
    if (arg === "--test-concurrency") {
      i++;
      continue;
    }
    userArgs.push(arg);
  }
  const testArgs = ["--test", `--test-concurrency=${concurrency}`, ...userArgs];
  const result = spawnSync(process.execPath, testArgs, {
    env: {
      ...process.env,
      ADG_CACHE_HOME: cacheHome,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEVELOPMENT_TRACES_ENDPOINT,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(cacheHome, { recursive: true, force: true });
}
