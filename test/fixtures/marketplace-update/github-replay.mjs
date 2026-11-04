// Test-only transport replay. Payloads are generated under a temporary directory.
import { appendFileSync, readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync(process.env.ADG_TEST_RELEASES, "utf8"));
const version = process.env.ADG_TEST_MARKETPLACE_VERSION;
const release = fixtures.releases[version];
if (!release) throw new Error("Unknown generated marketplace release");

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  appendFileSync(process.env.ADG_TEST_REMOTE_LOG, `${JSON.stringify({ version, url: url.href })}\n`);
  const base = `https://api.github.com/repos/${fixtures.source}`;
  if (url.href === `${base}/commits/HEAD`) return Response.json({ sha: release.commit });
  if (url.href === `${base}/tarball/HEAD`) {
    return new Response(readFileSync(release.archive), { headers: { "content-type": "application/x-gzip" } });
  }
  throw new Error(`Unexpected network request in isolated marketplace replay: ${url.href}`);
};
