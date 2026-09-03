#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selfUpdateCommand,
  parseSelfUpdateArgs,
  SELF_UPDATE_USAGE,
  selfUpdateSpawnOptions,
  formatSelfUpdateStart,
  formatSelfUpdateResult,
  selfUpdateFailureHint,
} from "../src/self-update.ts";
import { checkForUpdate, formatUpdateNotice } from "../src/update-check.ts";
import { ui } from "../src/render/ui.ts";
import { TARGET_ALIASES, TOP_USAGE, fail } from "../src/cli/index.ts";
import { ADAPTER_TARGETS } from "../src/adapters/index.ts";
import { runPlugins } from "../src/cli/handlers.ts";
import { getTracer, shutdownTelemetry, sanitizeArgs } from "../src/telemetry.ts";
import { SpanKind, SpanStatusCode, propagation, context } from "@opentelemetry/api";
import { runSubprocessSync } from "../src/subprocess.ts";
import { commandOutcome, type CommandOutcome } from "../src/command-outcome.ts";

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

export function telemetryCommandTarget(target: string | undefined): string {
  if (target === "all") return target;
  const canonical = target === undefined ? undefined : TARGET_ALIASES[target] ?? target;
  return canonical !== undefined && (ADAPTER_TARGETS as readonly string[]).includes(canonical)
    ? canonical
    : "none";
}

function runSkills(verb: string | undefined, rest: string[]): CommandOutcome {
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

  const childArgs = skillsChildArgv(entry, args);
  // The skills domain runs in a second Node process, so there is a cold-start
  // gap (~2s) before the child prints anything. Claim the screen first; `--help`
  // and the bare domain are excluded since they print immediately anyway.
  if (verb && !args.some((a) => a === "--help" || a === "-h")) {
    process.stderr.write(`${ui.title(`adg skills ${verb}`)}\n`);
  }
  const r = runSubprocessSync(process.execPath, childArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...envCarrier,
    },
  });
  const exitCode = r.status ?? 1;
  return exitCode === 0
    ? commandOutcome("success")
    : { ...commandOutcome("failure", "dependency"), exitCode };
}

function runSelfUpdate(args: string[]): CommandOutcome {
  const options = parseSelfUpdateArgs(args);
  if (options.help) {
    console.log(SELF_UPDATE_USAGE);
    return commandOutcome("success");
  }
  const command = selfUpdateCommand(options);
  if (options.dryRun) {
    console.log(`[dry-run] would run: ${command.command} ${command.args.join(" ")}`);
    return commandOutcome("success");
  }
  // npm's own inherited output is the progress indicator once it starts; this
  // frames the silent stretch before it and states what is about to happen.
  process.stderr.write(`${ui.meta(formatSelfUpdateStart(getVersion(), options))}\n`);
  const started = Date.now();
  const r = runSubprocessSync(command.command, command.args, selfUpdateSpawnOptions());
  if (r.error) {
    console.error(`${ui.err("error:")} ${r.error.message}`);
    console.error(ui.meta(selfUpdateFailureHint(options)));
    return commandOutcome("failure", "dependency");
  }
  const exitCode = r.status ?? 1;
  const elapsed = Date.now() - started;
  if (exitCode === 0) {
    process.stderr.write(`${ui.ok(formatSelfUpdateResult(true, elapsed))}\n`);
    return commandOutcome("success");
  }
  process.stderr.write(`${ui.err(formatSelfUpdateResult(false, elapsed))}\n`);
  console.error(ui.meta(selfUpdateFailureHint(options)));
  return { ...commandOutcome("failure", "dependency"), exitCode };
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

async function main(argv: string[]): Promise<number | void> {
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
  return await tracer.startActiveSpan("adg", { kind: SpanKind.INTERNAL }, async (span) => {
    let outcome = commandOutcome("success");
    try {
      span.setAttribute("process.executable.name", "adg");
      span.setAttribute("process.pid", process.pid);
      span.setAttribute("process.command_args", sanitizeArgs(["adg", ...argv]));
      const scope = rest.includes("--global") && rest.includes("--project")
        ? "both"
        : rest.includes("--global")
          ? "global"
          : rest.includes("--project")
            ? "project"
            : rest.some((arg) => arg === "--dir" || arg.startsWith("--dir="))
              ? "adhoc"
              : "none";
      const targetIndex = rest.findIndex((arg) => arg === "--target");
      const targetValue = targetIndex >= 0 ? rest[targetIndex + 1] : rest.find((arg) => arg.startsWith("--target="))?.slice(9);
      const target = telemetryCommandTarget(targetValue);
      span.setAttribute("adg.command.scope", scope);
      span.setAttribute("adg.command.target", target);

      // Check for an available update (reads local cache; schedules a background
      // network refresh when the cache is stale — the refresh uses an unreffed
      // socket so it cannot delay process exit).
      const currentVersion = getVersion();
      span.setAttribute("cli.version", currentVersion);
      const latestVersion = checkForUpdate(currentVersion);
      if (latestVersion && domain !== "update") {
        process.stderr.write(formatUpdateNotice(currentVersion, latestVersion));
      }

      switch (domain) {
        case "plugins":
        case "plugin": // tolerated alias
          span.setAttribute("adg.command.domain", "plugins");
          if (verb) span.setAttribute("adg.command.verb", verb);
          outcome = await runPlugins(verb, rest);
          break;
        case "skills":
        case "skill":
          span.setAttribute("adg.command.domain", "skills");
          if (verb) span.setAttribute("adg.command.verb", verb);
          outcome = runSkills(verb, rest);
          break;
        case "update":
          span.setAttribute("adg.command.domain", "update");
          if (verb) span.setAttribute("adg.command.verb", verb);
          outcome = runSelfUpdate([verb, ...rest].filter((x): x is string => x !== undefined));
          break;
        default:
          fail(`unknown domain: ${domain} (expected \`plugins\`, \`skills\`, or \`update\`)`);
      }

      span.setAttribute("adg.command.outcome", outcome.kind);
      span.setAttribute("process.exit.code", outcome.exitCode);
      if (outcome.exitCode !== 0) {
        span.setAttribute("error.type", `EXIT_CODE_${outcome.exitCode}`);
        span.setAttribute("error.category", outcome.errorCategory ?? "internal");
        span.setAttribute("error.expected", outcome.errorCategory === "user");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "CLI exited with a non-zero status",
        });
      }
      return outcome.exitCode;
    } catch (error) {
      outcome = commandOutcome("failure", "internal");
      span.setAttribute("adg.command.outcome", outcome.kind);
      span.setAttribute("process.exit.code", outcome.exitCode);
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : "_OTHER",
      );
      span.setAttribute("error.category", outcome.errorCategory!);
      span.setAttribute("error.expected", false);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "CLI command failed",
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
    .then(async (status) => {
      await shutdownTelemetry();
      process.exit(typeof status === "number" ? status : 0);
    })
    .catch(async (err) => {
      console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
      await shutdownTelemetry();
      process.exit(1);
    });
}
