import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchRepoTree, resetRepoTreeAuthState } from "../vendor/skills/src/blob.ts";

/**
 * Guards the ADG patch that lets `adg skills update` reach PRIVATE GitHub repos
 * (see vendor/skills/PROVENANCE.md → Local patches, docs/agents-spec.md). GitHub returns
 * 404 to anonymous tree requests for private repos; upstream only retried with a
 * token on a rate-limit 403, so private sources never authenticated. These tests
 * pin the corrected behavior by stubbing global fetch.
 */

type FetchStub = (url: string, init: { headers: Record<string, string> }) => Promise<unknown>;

function withFetch(stub: FetchStub, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = stub as unknown;
  resetRepoTreeAuthState();
  return fn().finally(() => {
    (globalThis as { fetch: unknown }).fetch = real;
    resetRepoTreeAuthState();
  });
}

const okTree = {
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ sha: "deadbeef", tree: [{ path: "skills/x/SKILL.md", type: "blob" }] }),
};
const notFound = {
  ok: false,
  status: 404,
  headers: { get: () => null },
  json: async () => ({}),
};

test("private repo: anonymous 404 triggers an authenticated retry that succeeds", async () => {
  let sawAuthHeader = false;
  await withFetch(
    async (_url, init) => {
      const auth = init.headers["Authorization"];
      if (auth) {
        sawAuthHeader = true;
        return okTree; // token unlocks the private repo
      }
      return notFound; // anonymous request can't see it
    },
    async () => {
      const tree = await fetchRepoTree("owner/private", "main", () => "ghp_testtoken");
      assert.ok(tree, "expected a tree once authenticated");
      assert.equal(tree!.sha, "deadbeef");
      assert.ok(sawAuthHeader, "expected the retry to send an Authorization header");
    },
  );
});

test("private repo: no token available yields null (no false success)", async () => {
  await withFetch(
    async (_url, _init) => notFound,
    async () => {
      const tree = await fetchRepoTree("owner/private", "main", () => null);
      assert.equal(tree, null);
    },
  );
});
