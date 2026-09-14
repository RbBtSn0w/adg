import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer } from "../telemetry.ts";
import { runSubprocessSync } from "../subprocess.ts";
import {
  type GitHubSource,
  type GitRunner,
  cloneGitHub,
  defaultGitRunner,
  gitRemoteRevision,
  gitRevision,
  parseGitHubSource,
} from "../sources.ts";

const GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_API_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

let cachedGhToken: string | null | undefined = undefined;

/**
 * Resolve a GitHub token from environment variables or the `gh` CLI.
 * Memoizes the result across the process lifetime to avoid spawning `gh` repeatedly.
 */
export function getGitHubToken(): string | null {
  if (cachedGhToken !== undefined) {
    return cachedGhToken;
  }

  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken?.trim()) {
    cachedGhToken = envToken.trim();
    return cachedGhToken;
  }

  try {
    const result = runSubprocessSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout?.trim()) {
      cachedGhToken = result.stdout.trim();
      return cachedGhToken;
    }
  } catch {
    // gh not installed or not authenticated
  }

  cachedGhToken = null;
  return null;
}

/** For tests only: reset cached token state. */
export function resetGitHubTokenCache(): void {
  cachedGhToken = undefined;
}

export interface RemoteDiagnosticErrors {
  api?: string;
  gh?: string;
  git?: string;
}

/**
 * Format a structured diagnostic message when remote resolution fails across all tiers.
 */
export function formatRemoteDiagnostic(source: string, errors: RemoteDiagnosticErrors): string {
  const parts: string[] = [`${source} could not be resolved across available transports:`];
  if (errors.api) parts.push(`  • GitHub API: ${errors.api}`);
  if (errors.gh) parts.push(`  • GitHub CLI: ${errors.gh}`);
  if (errors.git) parts.push(`  • Git CLI: ${errors.git}`);

  const hasNetworkError = [errors.api, errors.gh, errors.git].some(
    (e) => e && /(ECONNRESET|SSL_ERROR|framing layer|ETIMEDOUT|fetch failed|Could not resolve host)/i.test(e),
  );

  if (hasNetworkError) {
    parts.push(
      `  💡 Network reset or blocked connection detected. If in a restricted network environment, configure a proxy (export all_proxy=... or git config http.proxy) or run \`gh auth login\`.`,
    );
  }

  return parts.join("\n");
}

export interface ResolveRevisionOptions {
  token?: string | null;
  timeoutMs?: number;
  onDiagnostic?: (errors: RemoteDiagnosticErrors) => void;
}

/**
 * Resolves the immutable 40-character commit SHA for a remote GitHub repository.
 *
 * Employs a three-tier transport pipeline:
 *  1. HTTPS REST API (api.github.com) - direct, fast, supports token
 *  2. `gh` CLI (gh api) - inherits system credentials and enterprise config
 *  3. Git CLI (git ls-remote) - traditional git transport fallback
 */
export async function resolveRemoteRevision(
  source: string,
  ref?: string,
  opts: ResolveRevisionOptions = {},
): Promise<string | undefined> {
  if (ref && GIT_SHA_RE.test(ref)) {
    return ref.toLowerCase();
  }

  let parsed: GitHubSource;
  try {
    parsed = parseGitHubSource(source);
  } catch {
    // Not a GitHub source (e.g. generic git URL); delegate straight to gitRemoteRevision
    return gitRemoteRevision(source, ref);
  }

  const effectiveRef = ref || parsed.ref || "HEAD";
  const tracer = getTracer();
  return tracer.startActiveSpan("resolveRemoteRevision", { kind: SpanKind.INTERNAL }, async (span) => {
    span.setAttribute("remote.source", parsed.source);
    span.setAttribute("remote.ref", effectiveRef);

    const errors: RemoteDiagnosticErrors = {};
    const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const token = opts.token !== undefined ? opts.token : getGitHubToken();

    // ── Tier 1: HTTPS REST API ──────────────────────────────────────────────
    try {
      const apiUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(effectiveRef)}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "adg-cli",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const body = (await response.json()) as { sha?: unknown };
        if (typeof body.sha === "string" && GIT_SHA_RE.test(body.sha)) {
          span.setAttribute("remote.transport", "api");
          span.setAttribute("remote.revision", body.sha);
          return body.sha.toLowerCase();
        }
      } else {
        errors.api = `HTTP ${response.status} ${response.statusText}`;
      }
    } catch (err) {
      errors.api = err instanceof Error ? err.message : String(err);
    }

    // ── Tier 2: gh CLI (GitHub CLI) ─────────────────────────────────────────
    try {
      const endpoint = `repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(effectiveRef)}`;
      const result = runSubprocessSync(
        "gh",
        ["api", endpoint, "--jq", ".sha"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
        },
      );
      if (result.status === 0 && result.stdout?.trim()) {
        const sha = result.stdout.trim();
        if (GIT_SHA_RE.test(sha)) {
          span.setAttribute("remote.transport", "gh");
          span.setAttribute("remote.revision", sha);
          return sha.toLowerCase();
        }
      } else {
        const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
        errors.gh = stderr || `Exit code ${result.status}`;
      }
    } catch (err) {
      errors.gh = err instanceof Error ? err.message : String(err);
    }

    // ── Tier 3: Git CLI (ls-remote) ─────────────────────────────────────────
    try {
      const gitResult = gitRemoteRevision(parsed.source, effectiveRef);
      if (gitResult && GIT_SHA_RE.test(gitResult)) {
        span.setAttribute("remote.transport", "git");
        span.setAttribute("remote.revision", gitResult);
        return gitResult.toLowerCase();
      }
      errors.git = "No ref matched in ls-remote output";
    } catch (err) {
      errors.git = err instanceof Error ? err.message : String(err);
    }

    opts.onDiagnostic?.(errors);
    span.setStatus({ code: SpanStatusCode.ERROR, message: "All remote revision resolvers failed" });
    return undefined;
  });
}

export interface MaterializeOptions {
  sparse?: string[];
  runner?: GitRunner;
  resolvedRevision?: string;
  token?: string | null;
  timeoutMs?: number;
  preferTarball?: boolean;
}

export interface MaterializeResult {
  resolvedRevision: string | undefined;
  transport: "tarball" | "git";
}

/**
 * Materializes a remote repository source into a local directory.
 *
 * Prefers streaming GitHub Tarball extraction via `node-tar` when full source is needed,
 * avoiding git smart HTTP transport and SNI blocks. Falls back to `cloneGitHub` when
 * sparse checkout is requested or tarball streaming encounters issues.
 *
 * An injected test `runner` is honored directly to preserve offline mock hermeticity,
 * unless `opts.preferTarball` is explicitly requested.
 */
export async function materializeSource(
  source: GitHubSource,
  destDir: string,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const runner = opts.runner ?? defaultGitRunner;
  const isSparse = Boolean(opts.sparse && opts.sparse.filter(Boolean).length > 0);
  const shouldAttemptTarball = !isSparse && (!opts.runner || opts.preferTarball);

  if (!shouldAttemptTarball) {
    cloneGitHub(source, destDir, { sparse: opts.sparse, runner });
    const revision = opts.resolvedRevision ?? gitRevision(destDir);
    return { resolvedRevision: revision, transport: "git" as const };
  }

  const tracer = getTracer();
  return tracer.startActiveSpan("materializeSource", { kind: SpanKind.INTERNAL }, async (span): Promise<MaterializeResult> => {
    span.setAttribute("remote.source", source.source);
    const effectiveRef = source.ref || "HEAD";
    span.setAttribute("remote.ref", effectiveRef);

    // ── Tier 1: GitHub Tarball Streaming ────────────────────────────────────
    try {
      const token = opts.token !== undefined ? opts.token : getGitHubToken();
      const tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${encodeURIComponent(effectiveRef)}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "adg-cli",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(tarballUrl, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS),
      });

      if (response.ok && response.body) {
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          tar.x({ cwd: destDir, strip: 1 }),
        );

        let resolvedRevision = opts.resolvedRevision;
        if (!resolvedRevision) {
          // Resolve revision if not provided upfront
          resolvedRevision = await resolveRemoteRevision(source.source, effectiveRef, { token });
        }

        span.setAttribute("remote.transport", "tarball");
        if (resolvedRevision) span.setAttribute("remote.revision", resolvedRevision);
        return { resolvedRevision, transport: "tarball" as const };
      }
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      // Proceed to fallback
    }

    // ── Tier 2: Fallback to Git Clone ───────────────────────────────────────
    span.setAttribute("remote.transport", "git");
    // Ensure destination directory is completely empty before git clone,
    // avoiding "destination path already exists and is not an empty directory"
    try {
      for (const entry of readdirSync(destDir)) {
        rmSync(join(destDir, entry), { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error if directory does not exist yet
    }
    cloneGitHub(source, destDir, { runner });
    const revision = opts.resolvedRevision ?? gitRevision(destDir);
    if (revision) span.setAttribute("remote.revision", revision);
    return { resolvedRevision: revision, transport: "git" as const };
  });
}
