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
