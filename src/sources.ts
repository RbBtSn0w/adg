import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest, findManifestFile } from "./manifest.ts";
import type { PluginCandidate } from "./deps.ts";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer, sanitizeArgs } from "./telemetry.ts";

export interface GitHubSource {
  kind: "github";
  /** Normalized "owner/repo". */
  source: string;
  owner: string;
  repo: string;
  ref?: string;
  sourceUrl: string;
}

export interface LocalSource {
  kind: "local";
  dir: string;
}

export type ParsedSource = GitHubSource | LocalSource;

const GH_SHORTHAND = /^([\w.-]+)\/([\w.-]+?)(?:@(.+))?$/;
const GH_URL = /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@(.+))?$/;

/**
 * Parse an install spec into a local directory or a GitHub source.
 *
 * An existing local directory always wins; otherwise the spec is matched
 * against `owner/repo[@ref]` shorthand or a github.com URL.
 */
export function parseSource(spec: string): ParsedSource {
  if (existsSync(spec)) return { kind: "local", dir: spec };

  const url = spec.match(GH_URL);
  if (url) {
    const [, owner, repo, ref] = url;
    return gh(owner!, repo!, ref);
  }
  const short = spec.match(GH_SHORTHAND);
  if (short) {
    const [, owner, repo, ref] = short;
    return gh(owner!, repo!, ref);
  }
  throw new Error(`cannot parse install source: "${spec}" (expected a local path or owner/repo[@ref])`);
}

function gh(owner: string, repo: string, ref?: string): GitHubSource {
  return {
    kind: "github",
    source: `${owner}/${repo}`,
    owner,
    repo,
    ref,
    sourceUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

/**
 * Shallow-clone a GitHub source into `dest`, optionally restricting the working
 * tree to `sparse` sub-paths (cone-mode sparse checkout) for large monorepos.
 * The git runner is injectable so the flow can be exercised offline in tests.
 */
export function cloneGitHub(
  src: GitHubSource,
  dest: string,
  opts: { sparse?: string[]; runner?: GitRunner } = {},
): string {
  const runner = opts.runner ?? defaultGitRunner;
  const sparse = opts.sparse?.filter(Boolean) ?? [];

  const clone = ["clone", "--depth", "1"];
  if (src.ref) clone.push("--branch", src.ref);
  if (sparse.length > 0) clone.push("--filter=blob:none", "--sparse");
  clone.push(src.sourceUrl, dest);
  runner(clone);

  if (sparse.length > 0) {
    runner(["-C", dest, "sparse-checkout", "set", ...sparse]);
  }
  return dest;
}

export type GitRunner = (args: string[]) => void;

const defaultGitRunner: GitRunner = (args) => {
  const tracer = getTracer();
  return tracer.startActiveSpan("git", { kind: SpanKind.CLIENT }, (span) => {
    try {
      span.setAttribute("process.executable.name", "git");
      span.setAttribute("process.command_args", sanitizeArgs(["git", ...args]));

      execFileSync("git", args, { stdio: "pipe" });

      span.setAttribute("process.exit.code", 0);
    } catch (error: any) {
      const exitCode = typeof error.status === "number" ? error.status : 1;
      span.setAttribute("process.exit.code", exitCode);
      if (typeof error.pid === "number") {
        span.setAttribute("process.pid", error.pid);
      }
      span.setAttribute("error.type", error.code || error.name || `EXIT_CODE_${exitCode}`);
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      throw error;
    } finally {
      span.end();
    }
  });
};

/**
 * Recursively find ADG plugins under `root` (directories containing
 * `.agents/.plugin.json`, or the legacy `.adg-plugin/plugin.json`), keyed by
 * manifest name. Used as the resolution universe for dependency ordering.
 */
export function scanPlugins(root: string): Map<string, PluginCandidate> {
  const found = new Map<string, PluginCandidate>();
  walk(root, root, found);
  return found;
}

function walk(root: string, current: string, out: Map<string, PluginCandidate>): void {
  if (findManifestFile(current)) {
    const manifest = readManifest(current);
    if (!out.has(manifest.name)) out.set(manifest.name, { dir: current, manifest });
    return; // do not descend into a plugin directory
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    walk(root, join(current, entry.name), out);
  }
}

export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");

export interface NativePlugin {
  dir: string;
  /** Which runtime-native manifest was found. */
  kind: "adg" | "codex" | "claude";
  /** Path to the native manifest file. */
  manifestFile: string;
}

/**
 * Recursively find plugin directories under `root`, recognizing ADG, Codex and
 * Claude manifests. Used by `import` to discover existing plugins to convert.
 */
export function scanNativePlugins(root: string): NativePlugin[] {
  const found: NativePlugin[] = [];
  walkNative(root, found);
  return found;
}

function walkNative(current: string, out: NativePlugin[]): void {
  // Resolution priority: canonical .agents/.plugin.json first, then Claude, then
  // Codex. Only matters when a single dir exposes more than one manifest.
  const adg = findManifestFile(current);
  const claude = join(current, CLAUDE_MANIFEST_PATH);
  const codex = join(current, CODEX_MANIFEST_PATH);
  if (adg) {
    out.push({ dir: current, kind: "adg", manifestFile: adg });
    return;
  }
  if (existsSync(claude)) {
    out.push({ dir: current, kind: "claude", manifestFile: claude });
    return;
  }
  if (existsSync(codex)) {
    out.push({ dir: current, kind: "codex", manifestFile: codex });
    return;
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    walkNative(join(current, entry.name), out);
  }
}
