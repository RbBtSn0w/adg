import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import {
  formatRemoteDiagnostic,
  getGitHubToken,
  materializeSource,
  resetGitHubTokenCache,
  resolveRemoteRevision,
} from "../src/remote/client.ts";
import type { GitHubSource } from "../src/sources.ts";

test("resolveRemoteRevision returns 40-char commit SHA immediately without network probe", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const resolved = await resolveRemoteRevision("anthropics/knowledge-work-plugins", sha);
  assert.equal(resolved, sha);
});

test("resolveRemoteRevision falls back to gitRemoteRevision for non-GitHub sources", async () => {
  const resolved = await resolveRemoteRevision("https://gitlab.com/some/repo.git", "main");
  // gitRemoteRevision will return undefined in this test environment without failing
  assert.equal(resolved, undefined);
});

test("resolveRemoteRevision succeeds on Tier 1 (HTTPS REST API)", async () => {
  const expectedSha = "abcdef0123456789abcdef0123456789abcdef01";
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("commits/HEAD")) {
        return new Response(JSON.stringify({ sha: expectedSha }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    };

    const resolved = await resolveRemoteRevision("test-owner/test-repo");
    assert.equal(resolved, expectedSha);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("resolveRemoteRevision falls back to Tier 3 when API fails and gh is unavailable", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("Network unreachable (simulated)");
    };

    let diagnosticErrors: import("../src/remote/client.ts").RemoteDiagnosticErrors = {};
    const resolved = await resolveRemoteRevision("test-owner/test-repo-nonexistent", undefined, {
      onDiagnostic: (errors) => {
        diagnosticErrors = errors;
      },
    });

    assert.equal(resolved, undefined);
    assert.match(diagnosticErrors.api ?? "", /Network unreachable/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("formatRemoteDiagnostic formats structured message and suggests proxy on network reset", () => {
  const msg = formatRemoteDiagnostic("test-owner/test-repo", {
    api: "fetch failed: LibreSSL SSL_ERROR_SYSCALL",
    gh: "Exit code 1",
    git: "fatal: unable to access: Error in the HTTP2 framing layer",
  });

  assert.match(msg, /test-owner\/test-repo could not be resolved across available transports/);
  assert.match(msg, /GitHub API: fetch failed: LibreSSL SSL_ERROR_SYSCALL/);
  assert.match(msg, /Network reset or blocked connection detected/);
  assert.match(msg, /export all_proxy=\.\.\./);
});

test("getGitHubToken reads environment variables and caches across calls", () => {
  const origEnv = process.env.GITHUB_TOKEN;
  try {
    resetGitHubTokenCache();
    process.env.GITHUB_TOKEN = "ghp_testtoken12345";
    assert.equal(getGitHubToken(), "ghp_testtoken12345");

    // Clear env to prove memoization
    delete process.env.GITHUB_TOKEN;
    assert.equal(getGitHubToken(), "ghp_testtoken12345");
  } finally {
    if (origEnv !== undefined) {
      process.env.GITHUB_TOKEN = origEnv;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    resetGitHubTokenCache();
  }
});

test("materializeSource delegates to runner when offline runner is injected", async () => {
  const dest = mkdtempSync(join(tmpdir(), "adg-test-mat-"));
  try {
    const invoked: string[][] = [];
    const dummyRunner = (args: string[]) => {
      invoked.push(args);
      // Simulate cloned directory
      writeFileSync(join(dest, "README.md"), "test");
    };

    const source: GitHubSource = {
      kind: "github",
      source: "owner/repo",
      owner: "owner",
      repo: "repo",
      sourceUrl: "https://github.com/owner/repo.git",
    };

    const result = await materializeSource(source, dest, { runner: dummyRunner });
    assert.equal(result.transport, "git");
    assert.equal(invoked.length, 1);
    assert.deepEqual(invoked[0]?.slice(0, 3), ["clone", "--depth", "1"]);
    assert.equal(existsSync(join(dest, "README.md")), true);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("materializeSource extracts tarball directly via stream pipeline", async () => {
  const dest = mkdtempSync(join(tmpdir(), "adg-test-tar-"));
  const staging = mkdtempSync(join(tmpdir(), "adg-test-staging-"));
  const origFetch = globalThis.fetch;

  try {
    // Create a real tarball archive to stream
    const innerDir = join(staging, "repo-root");
    mkdirSync(innerDir);
    writeFileSync(join(innerDir, "manifest.json"), JSON.stringify({ name: "streamed-plugin" }));
    const tarballBuffer = await tar.create(
      {
        gzip: true,
        cwd: staging,
      },
      ["repo-root"],
    ).concat();

    globalThis.fetch = async (url) => {
      if (String(url).includes("tarball/HEAD")) {
        return new Response(tarballBuffer, {
          status: 200,
          headers: {
            "content-type": "application/x-gzip",
            etag: '"1234567890abcdef1234567890abcdef12345678"',
          },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const source: GitHubSource = {
      kind: "github",
      source: "owner/repo",
      owner: "owner",
      repo: "repo",
      sourceUrl: "https://github.com/owner/repo.git",
    };

    const result = await materializeSource(source, dest, {
      resolvedRevision: "1234567890abcdef1234567890abcdef12345678",
    });

    assert.equal(result.transport, "tarball");
    assert.equal(result.resolvedRevision, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(existsSync(join(dest, "manifest.json")), true);
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dest, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
});

test("materializeSource cleans up partially extracted destDir when falling back to git clone", async () => {
  const dest = mkdtempSync(join(tmpdir(), "adg-test-fallback-"));
  const origFetch = globalThis.fetch;

  try {
    // Put a leftover file in dest to simulate interrupted extraction
    writeFileSync(join(dest, "leftover.tmp"), "corrupt");

    globalThis.fetch = async () => {
      throw new Error("Tarball download failed (simulated)");
    };

    let cloneDestinationWasEmpty = false;
    const runner = (args: string[]) => {
      // At the point clone is called, dest should have had leftover.tmp removed
      const files = existsSync(join(dest, "leftover.tmp"));
      cloneDestinationWasEmpty = !files;
      writeFileSync(join(dest, "cloned.txt"), "ok");
    };

    const source: GitHubSource = {
      kind: "github",
      source: "owner/repo",
      owner: "owner",
      repo: "repo",
      sourceUrl: "https://github.com/owner/repo.git",
    };

    const result = await materializeSource(source, dest, { runner, preferTarball: true });
    assert.equal(result.transport, "git");
    assert.equal(cloneDestinationWasEmpty, true);
    assert.equal(existsSync(join(dest, "cloned.txt")), true);
  } finally {
    globalThis.fetch = origFetch;
    rmSync(dest, { recursive: true, force: true });
  }
});

