import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheHome = mkdtempSync(join(tmpdir(), "adg-test-cache-"));

try {
  // Tests that exercise relative paths temporarily change the process-wide CWD.
  // Keep Windows runs serial so one test cannot hold another test's temp CWD
  // open while its cleanup calls rmSync(..., { recursive: true }).
  const testArgs = process.platform === "win32"
    ? ["--test", "--test-concurrency=1", ...process.argv.slice(2)]
    : ["--test", ...process.argv.slice(2)];
  const result = spawnSync(process.execPath, testArgs, {
    env: { ...process.env, ADG_CACHE_HOME: cacheHome },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(cacheHome, { recursive: true, force: true });
}
