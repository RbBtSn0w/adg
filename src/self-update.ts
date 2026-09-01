import { prereleaseChannel } from "./semver.ts";

export const PACKAGE_NAME = "@rbbtsn0w/adg";

export interface SelfUpdateOptions {
  beta: boolean;
  help: boolean;
}

export function parseSelfUpdateArgs(args: string[]): SelfUpdateOptions {
  const options: SelfUpdateOptions = { beta: false, help: false };
  for (const arg of args) {
    if (arg === "--beta" || arg === "-b") {
      options.beta = true;
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

export function selfUpdateTarget(beta: boolean): string {
  return beta ? "beta" : "latest";
}

export function selfUpdateCommand(beta: boolean, npmBin = "npm"): { command: string; args: string[] } {
  return {
    command: npmBin,
    args: ["install", "-g", `${PACKAGE_NAME}@${selfUpdateTarget(beta)}`],
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
export function formatSelfUpdateStart(currentVersion: string, beta: boolean): string {
  const { command, args } = selfUpdateCommand(beta);
  return `adg ${currentVersion} → installing ${selfUpdateTarget(beta)} (${command} ${args.join(" ")})`;
}

/** Closing line for a self-update run. */
export function formatSelfUpdateResult(ok: boolean, elapsedMs: number): string {
  const seconds = `${(elapsedMs / 1000).toFixed(1)}s`;
  return ok
    ? `updated · ${seconds} — run \`adg --version\` to confirm`
    : `update failed · ${seconds}`;
}

/** Actionable next step when npm could not be launched or exited non-zero. */
export function selfUpdateFailureHint(beta: boolean): string {
  const { command, args } = selfUpdateCommand(beta);
  return `try running it directly: ${command} ${args.join(" ")}\nif that fails with EACCES, npm's global prefix needs write access (or install via a version manager).`;
}

export function selfUpdateHint(latestVersion: string): string {
  const channel = prereleaseChannel(latestVersion);
  if (channel === "beta") return "adg update --beta";
  if (channel) return `npm install -g ${PACKAGE_NAME}@${latestVersion}`;
  return "adg update";
}

export const SELF_UPDATE_USAGE = `adg update — upgrade the ADG CLI

Usage:
  adg update
        Install the latest stable release with npm.
  adg update --beta
  adg update -b
        Install the latest beta release with npm.`;
