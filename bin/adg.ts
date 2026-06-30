#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate, formatUpdateNotice } from "../src/update-check.ts";
import { ui } from "../src/render/ui.ts";
import { TOP_USAGE, fail } from "../src/cli/index.ts";
import { runPlugins } from "../src/cli/handlers.ts";
import { getTracer, shutdownTelemetry } from "../src/telemetry.ts";
import { SpanStatusCode, propagation, context } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// `adg` entry point: thin wire-up only.
//
// The CLI surface — flag table, command tables, help rendering, scope/target
// resolution, and the per-verb handlers — lives in `src/cli/` so it can be
// unit-tested without spawning a subprocess. This file owns just the bits that
// genuinely need the process: domain routing, the `skills` subprocess bridge,
// version/update reporting, and the direct-invocation guard.
// ---------------------------------------------------------------------------

/**
 * Delegate to the vendored `skills` CLI (vendor/skills, a fork of
 * vercel-labs/skills — see vendor/skills/PROVENANCE.md). We run its source
 * entry directly under Node's TypeScript support and forward all args/stdio.
 */
/**
 * Args for re-invoking Node on a `.ts` entry. `process.execArgv` is forwarded so
 * the child inherits the parent's Node flags (e.g. --experimental-strip-types,
 * required to run TypeScript directly on Node 22.6–23.5). `execArgv` is a
 * parameter so the forwarding can be tested with a non-empty flag set.
 */
export function skillsChildArgv(
  entry: string,
  args: string[],
  execArgv: string[] = process.execArgv
): string[] {
  return [...execArgv, entry, ...args];
}

function runSkills(verb: string | undefined, rest: string[]): void {
  const self = fileURLToPath(import.meta.url);
  const here = dirname(self);
  // Resolve the vendored CLI with the same extension we ourselves run as: `.ts`
  // when running source directly under Node's type stripping (dev / npm link),
  // `.js` when running the compiled `dist/` output (published install). Node
  // refuses to strip types under node_modules, so the published bin and the
  // vendored entry must both be the built `.js`.
  const ext = self.endsWith(".ts") ? ".ts" : ".js";
  const entry = join(here, "..", "vendor", "skills", "src", `cli${ext}`);
  const args = [verb, ...rest].filter((x): x is string => x !== undefined);

  // Inject current active OpenTelemetry context into environment variables
  const envCarrier: Record<string, string> = {};
  propagation.inject(context.active(), envCarrier);

  const r = spawnSync(process.execPath, skillsChildArgv(entry, args), {
    stdio: "inherit",
    env: {
      ...process.env,
      ...envCarrier,
    },
  });
  process.exit(r.status ?? 1);
}

/**
 * Read the package version from package.json.
 *
 * Works in both source mode (`bin/adg.ts` → package.json is 1 level up) and
 * compiled mode (`dist/bin/adg.js` → package.json is 2 levels up).
 */
export function getVersion(): string {
  const self = fileURLToPath(import.meta.url);
  // Source: bin/adg.ts  → up 1 level reaches the repo root.
  // Compiled: dist/bin/adg.js → up 2 levels reaches the repo root.
  const up = self.endsWith(".ts") ? ".." : join("..", "..");
  const pkg = JSON.parse(readFileSync(join(dirname(self), up, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<void> {
  const [domain, verb, ...rest] = argv;

  // --version / -v at the root level: print version and exit.
  // Note: `-v` is also the short flag for `--verbose` in subcommands, but only
  // when it appears *after* a domain (e.g. `adg plugins list -v`). Checking
  // argv[0] here means we only intercept `adg -v` / `adg --version`, never
  // a subcommand's own flags.
  if (domain === "--version" || domain === "-v") {
    console.log(getVersion());
    return;
  }

  if (!domain || domain === "help" || domain === "--help" || domain === "-h") {
    console.log(TOP_USAGE);
    return;
  }

  const tracer = getTracer();
  return await tracer.startActiveSpan(`adg-${domain || "help"}`, async (span) => {
    try {
      // Check for an available update (reads local cache; schedules a background
      // network refresh when the cache is stale — the refresh uses an unreffed
      // socket so it cannot delay process exit).
      const currentVersion = getVersion();
      const latestVersion = checkForUpdate(currentVersion);
      if (latestVersion) {
        process.stderr.write(formatUpdateNotice(currentVersion, latestVersion));
      }

      switch (domain) {
        case "plugins":
        case "plugin": // tolerated alias
          span.setAttribute("domain", "plugins");
          if (verb) span.setAttribute("verb", verb);
          return await runPlugins(verb, rest);
        case "skills":
        case "skill":
          span.setAttribute("domain", "skills");
          if (verb) span.setAttribute("verb", verb);
          // runSkills calls process.exit, so we MUST shutdown telemetry here!
          await shutdownTelemetry();
          return runSkills(verb, rest);
        default:
          fail(`unknown domain: ${domain} (expected \`plugins\` or \`skills\`)`);
      }
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Only run the CLI when executed directly, so the module can be imported by tests.
// `import.meta.url` is already realpath-resolved by Node, but `process.argv[1]`
// is the path as invoked — when the bin is reached through a symlink (e.g.
// `npm link`'s global shim), that path is the unresolved symlink, so a raw
// string compare misses and `main()` never runs. Resolve argv[1] to its
// realpath before comparing so symlinked invocations still start the CLI.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = resolve(entry);
  }
  return fileURLToPath(import.meta.url) === resolved;
}

if (isInvokedDirectly()) {
  main(process.argv.slice(2))
    .then(async () => {
      await shutdownTelemetry();
    })
    .catch(async (err) => {
      console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
      await shutdownTelemetry();
      process.exit(1);
    });
}
