import { prereleaseChannel } from "./semver.ts";

export const PACKAGE_NAME = "@rbbtsn0w/adg";

export interface SelfUpdateOptions {
  beta: boolean;
  dev: boolean;
  tag?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseSelfUpdateArgs(args: string[]): SelfUpdateOptions {
  const options: SelfUpdateOptions = {
    beta: false,
    dev: false,
    tag: undefined,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--beta" || arg === "-b") {
      options.beta = true;
      continue;
    }
    if (arg === "--dev") {
      options.dev = true;
      continue;
    }
    if (arg === "--tag" || arg === "-t") {
      const val = args[++i];
      if (!val || val.startsWith("-")) {
        throw new Error(`flag \`${arg}\` requires a version or dist-tag argument`);
      }
      options.tag = val;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      const val = arg.slice("--tag=".length);
      if (!val) {
        throw new Error(`flag \`--tag\` requires a version or dist-tag argument`);
      }
      options.tag = val;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(arg.startsWith("-")
      ? `unknown flag for \`adg update\`: ${arg}`
      : `adg update takes no positional arguments (got: ${arg})`);
  }
  return options;
}

export type SelfUpdateTargetInput = boolean | { beta?: boolean; dev?: boolean; tag?: string };

export function selfUpdateTarget(target: SelfUpdateTargetInput): string {
  if (typeof target === "boolean") {
    return target ? "beta" : "latest";
  }
  if (target.tag) {
    return target.tag;
  }
  if (target.dev) {
    return "next";
  }
  if (target.beta) {
    return "beta";
  }
  return "latest";
}

export function selfUpdateCommand(
  target: SelfUpdateTargetInput,
  npmBin = "npm"
): { command: string; args: string[] } {
  return {
    command: npmBin,
    args: ["install", "-g", `${PACKAGE_NAME}@${selfUpdateTarget(target)}`],
  };
}

export function selfUpdateSpawnOptions(platform: NodeJS.Platform = process.platform): { stdio: "inherit"; shell: boolean } {
  return { stdio: "inherit", shell: platform === "win32" };
}

/**
 * The line printed before npm is spawned. `npm install -g` is silent for several
 * seconds, so without this the command that is *named* "update" shows nothing at
 * all until npm's summary block appears.
 */
export function formatSelfUpdateStart(currentVersion: string, target: SelfUpdateTargetInput): string {
  const { command, args } = selfUpdateCommand(target);
  return `adg ${currentVersion} → installing ${selfUpdateTarget(target)} (${command} ${args.join(" ")})`;
}

/** Closing line for a self-update run. */
export function formatSelfUpdateResult(ok: boolean, elapsedMs: number): string {
  const seconds = `${(elapsedMs / 1000).toFixed(1)}s`;
  return ok
    ? `updated · ${seconds} — run \`adg --version\` to confirm`
    : `update failed · ${seconds}`;
}

/** Actionable next step when npm could not be launched or exited non-zero. */
export function selfUpdateFailureHint(target: SelfUpdateTargetInput): string {
  const { command, args } = selfUpdateCommand(target);
  return `try running it directly: ${command} ${args.join(" ")}\nif that fails with EACCES, npm's global prefix needs write access (or install via a version manager).`;
}

export function selfUpdateHint(latestVersion: string): string {
  const channel = prereleaseChannel(latestVersion);
  if (channel === "beta") return "adg update --beta";
  if (channel === "dev" || channel === "next") return "adg update --dev";
  if (channel) return `adg update --tag ${latestVersion}`;
  return "adg update";
}

export const SELF_UPDATE_USAGE = `adg update — upgrade the ADG CLI

Usage:
  adg update
        Install the latest stable release with npm.
  adg update --beta
  adg update -b
        Install the latest beta release with npm.
  adg update --dev
        Install the latest PR development / canary release (dist-tag: next).
  adg update --tag <tag|version>
  adg update -t <tag|version>
        Install a specific version or dist-tag with npm.
  adg update --dry-run
        Simulate update command without running npm.`;
