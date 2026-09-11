import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";

const cacheHome = mkdtempSync(join(tmpdir(), "adg-test-cache-"));

try {
  // Tests that exercise relative paths temporarily change the process-wide CWD.
  // Keep Windows runs serial so one test cannot hold another test's temp CWD
  // open while its cleanup calls rmSync(..., { recursive: true }).
  // On other platforms, cap concurrency to prevent Node test runner IPC buffer overflows.
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
    env: { ...process.env, ADG_CACHE_HOME: cacheHome },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(cacheHome, { recursive: true, force: true });
}
