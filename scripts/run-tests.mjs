import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cacheHome = mkdtempSync(join(tmpdir(), "adg-test-cache-"));

try {
  const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], {
    env: { ...process.env, ADG_CACHE_HOME: cacheHome },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(cacheHome, { recursive: true, force: true });
}
