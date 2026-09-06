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
  /** Optional subdirectory inferred from a browser URL to a plugin manifest or folder. */
  path?: string;
  sourceUrl: string;
}

export interface LocalSource {
  kind: "local";
  dir: string;
}

export type ParsedSource = GitHubSource | LocalSource;

/** Best-effort repository About lookup. Callers must retain their deterministic fallback on failure. */
export async function githubRepositoryDescription(repo: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "adg-cli" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { description?: unknown };
    return typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined;
  } catch { return undefined; }
}

const GH_SHORTHAND = /^([\w.-]+)\/([\w.-]+?)(?:@(.+))?$/;
const GH_URL = /^(?:https?:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@(.+))?$/;
const GH_BLOB_URL = /^(?:https?:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(?:blob|tree)\/([^/]+)\/(.+)$/;

function stripKnownManifestSuffix(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const suffixes = [
    ".agents/.plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".adg-plugin/plugin.json",
  ];
  for (const suffix of suffixes) {
    if (normalized === suffix) return "";
    if (normalized.endsWith(`/${suffix}`)) return normalized.slice(0, -(suffix.length + 1));
  }
  return normalized;
}

function decodeGitHubUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse an install spec into a local directory or a GitHub source.
 *
 * An existing local directory always wins; otherwise the spec is matched
 * against `owner/repo[@ref]` shorthand or a github.com URL.
 */
export function parseSource(spec: string): ParsedSource {
  if (existsSync(spec)) return { kind: "local", dir: spec };

  try {
    return parseGitHubSource(spec);
  } catch {
    throw new Error(`cannot parse install source: "${spec}" (expected a local path, owner/repo[@ref], or a github.com URL)`);
  }
}

/** Parse a GitHub source without allowing an existing CWD path to override it. */
export function parseGitHubSource(spec: string): GitHubSource {

  const clean = spec.replace(/[?#].*$/, "");
  const blob = clean.match(GH_BLOB_URL);
  if (blob) {
    const [, owner, repo, ref, path] = blob;
    const decodedRef = decodeGitHubUrlPart(ref!);
    const decodedPath = decodeGitHubUrlPart(path!);
    return { ...gh(owner!, repo!, decodedRef), path: stripKnownManifestSuffix(decodedPath) };
  }

  const url = clean.match(GH_URL);
  if (url) {
    const [, owner, repo, ref] = url;
    return gh(owner!, repo!, ref);
  }
  const short = clean.match(GH_SHORTHAND);
  if (short) {
    const [, owner, repo, ref] = short;
    return gh(owner!, repo!, ref);
  }
  throw new Error(`cannot parse GitHub source: "${spec}" (expected owner/repo[@ref] or a github.com URL)`);
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

/**
 * Default timeouts. A remote probe is a metadata round trip and should be quick;
 * a clone legitimately takes minutes on a large repository. Both exist because
 * an unbounded `execFileSync` here is an indefinite, output-free hang.
 */
export const GIT_REMOTE_PROBE_TIMEOUT_MS = 20_000;
export const GIT_CLONE_TIMEOUT_MS = 300_000;

export type GitRunner = (args: string[]) => void;

export const defaultGitRunner: GitRunner = (args) => {
  runGit(args, false, GIT_CLONE_TIMEOUT_MS);
};

/** Return a low-cardinality, string-safe error type for Git subprocess spans. */
export function gitErrorType(error: unknown, exitCode: number): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === undefined || code === null ? `EXIT_CODE_${exitCode}` : String(code);
}

/**
 * Environment for every git subprocess we spawn.
 *
 * `GIT_TERMINAL_PROMPT=0` is the important one: a private or moved repository
 * makes git prompt for credentials, and because these calls run with
 * `stdio: "ignore"` that prompt is invisible — the CLI simply hangs forever with
 * nothing on screen. Disabling the prompt turns that into a fast, reportable
 * failure that surfaces per-source as "could not be checked". `GIT_ASKPASS` /
 * `SSH_ASKPASS` are neutralized for the same reason: an IDE-injected helper can
 * re-introduce an invisible interactive wait. Ordinary credential helpers
 * (`credential.helper`), proxies, and `SSH_AUTH_SOCK` are left alone, matching
 * the vendored fork's sanitization (see vendor/skills/src/git.ts).
 *
 * Deliberately NOT set: `GIT_SSH_COMMAND`. The environment variable outranks the
 * `core.sshCommand` git config, so defaulting it here would silently discard a
 * user's configured ssh invocation (a deploy key, a proxy command) for `git`
 * origins that carry an ssh URL. Bounding ssh's own prompts is the timeout's
 * job, not this function's.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Case-insensitive: Windows env keys preserve case but compare insensitively,
  // so an exact-key delete alone can be bypassed.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "GIT_ASKPASS" || upper === "SSH_ASKPASS") delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Run git under the shared CLI semantic-convention instrumentation. */
export function runGit(args: string[], captureOutput = false, timeoutMs?: number): string | undefined {
  const tracer = getTracer();
  return tracer.startActiveSpan("git", { kind: SpanKind.CLIENT }, (span) => {
    try {
      span.setAttribute("process.executable.name", "git");
      span.setAttribute("process.command_args", sanitizeArgs(["git", ...args]));

      const output = execFileSync("git", args, {
        ...(captureOutput
          ? { stdio: "pipe" as const, encoding: "utf8" as const }
          : { stdio: "ignore" as const }),
        env: gitEnv(),
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });

      span.setAttribute("process.exit.code", 0);
      return captureOutput ? String(output).trimEnd() : undefined;
    } catch (error: any) {
      const exitCode = typeof error.status === "number" ? error.status : 1;
      span.setAttribute("process.exit.code", exitCode);
      if (typeof error.pid === "number") {
        span.setAttribute("process.pid", error.pid);
      }
      span.setAttribute("error.type", gitErrorType(error, exitCode));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "Git subprocess failed",
      });
      throw error;
    } finally {
      span.end();
    }
  });
};

/** Resolve the immutable commit checked out in a cloned worktree. */
export function gitRevision(dir: string): string | undefined {
  try {
    return runGit(["-C", dir, "rev-parse", "HEAD"], true) || undefined;
  } catch {
    // Injected/offline clone runners in tests may materialize a plain directory.
    // Such entries remain legacy until a real update records an immutable commit.
    return undefined;
  }
}

const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

/** Extract the commit SHA from `git ls-remote`, preferring an annotated tag's peeled ref. */
export function parseRemoteRevision(output: string | undefined, ref?: string): string | undefined {
  if (!output) return undefined;
  const rows = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter(([sha, name]) => GIT_SHA_RE.test(sha ?? "") && name);
  const peeled = ref ? rows.find(([, name]) => name === `refs/tags/${ref}^{}`)?.[0] : undefined;
  return peeled ?? rows[0]?.[0];
}

/** Lightweight remote commit probe used to avoid cloning an unchanged source. */
export function gitRemoteRevision(repo: string, ref?: string): string | undefined {
  if (ref && GIT_SHA_RE.test(ref)) return ref.toLowerCase();
  try {
    const pattern = ref || "HEAD";
    const output = runGit(
      ["ls-remote", `https://github.com/${repo}.git`, pattern, `${pattern}^{}`],
      true,
      GIT_REMOTE_PROBE_TIMEOUT_MS,
    );
    return parseRemoteRevision(output, ref);
  } catch { return undefined; }
}

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
