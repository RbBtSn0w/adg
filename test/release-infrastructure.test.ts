import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

test("configured semantic-release plugins render notes and preserve release classification", () => {
  const script = `
    import { readFileSync } from 'node:fs';
    import { generateNotes } from '@semantic-release/release-notes-generator';
    import { analyzeCommits } from '@semantic-release/commit-analyzer';
    const config = JSON.parse(readFileSync('.releaserc.json', 'utf8'));
    const plugin = name => config.plugins.find(p => Array.isArray(p) && p[0] === name)[1];
    const commits = ['feat: add release example', 'fix: repair release example', 'chore: hidden maintenance example']
      .map((message, i) => ({message, hash: String(i + 1).repeat(40)}));
    const context = {cwd: process.cwd(), env: process.env, commits,
      logger: {log() {}}, options: {repositoryUrl: 'https://github.com/RbBtSn0w/adg.git'},
      lastRelease: {gitTag: '1.0.0'}, nextRelease: {version: '1.1.0', gitTag: '1.1.0'}};
    const notes = await generateNotes(plugin('@semantic-release/release-notes-generator'), context);
    const release = await analyzeCommits(plugin('@semantic-release/commit-analyzer'), context);
    console.log(JSON.stringify({notes, release}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const { notes, release } = JSON.parse(result.stdout);
  assert.match(notes, /Added/);
  assert.match(notes, /Fixed/);
  assert.match(notes, /add release example/);
  assert.match(notes, /repair release example/);
  assert.doesNotMatch(notes, /hidden maintenance example/);
  assert.equal(release, "minor");
});

test("CI covers the minimum Node runtime and repository release gates", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.match(workflow, /node-version:\s*["']?22\.18\.0["']?/);
  assert.match(workflow, /npm run check:docs/);
  assert.match(workflow, /npm run test:package/);
  assert.match(workflow, /npm run check:vendor-upstream/);
  assert.doesNotMatch(workflow, /pr-dev-release:|id-token: write|npm publish/);
  assert.ok(pkg.scripts?.["check:docs"]);
  assert.ok(pkg.scripts?.["check:package-smoke"]);
  assert.ok(pkg.scripts?.["check:vendor-upstream"]);
});

test("workflows pin third-party actions to immutable commits", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/pr-commit-semantics.yml",
  ]) {
    const workflow = readFileSync(resolve(file), "utf8");
    const refs = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+)/gm)].map((match) => match[1]!);
    assert.ok(refs.length > 0, `${file} should use at least one action`);
    for (const ref of refs) assert.match(ref, /^[0-9a-f]{40}$/, `${file} contains a mutable action ref: ${ref}`);
  }
});

test("dependabot targets main and groups dependencies to avoid PR surges", () => {
  const dependabotRaw = readFileSync(resolve(".github/dependabot.yml"), "utf8");
  const dependabot = YAML.parse(dependabotRaw) as {
    updates: Array<{
      "package-ecosystem": string;
      "target-branch": string;
      "open-pull-requests-limit": number;
      schedule: { interval: string; day?: string };
      groups?: Record<string, { patterns: string[] }>;
    }>;
  };

  assert.equal(dependabot.updates.length, 2);

  const npm = dependabot.updates.find((u) => u["package-ecosystem"] === "npm");
  assert.ok(npm, "npm ecosystem entry exists");
  assert.equal(npm["target-branch"], "main");
  assert.equal(npm["open-pull-requests-limit"], 5);
  assert.equal(npm.schedule.interval, "weekly");
  assert.equal(npm.schedule.day, "wednesday");
  assert.ok(npm.groups?.opentelemetry);
  assert.ok(npm.groups?.["semantic-release"]);
  assert.ok(npm.groups?.types);
  assert.ok(npm.groups?.dependencies);

  const actions = dependabot.updates.find((u) => u["package-ecosystem"] === "github-actions");
  assert.ok(actions, "github-actions ecosystem entry exists");
  assert.equal(actions["target-branch"], "main");
  assert.equal(actions["open-pull-requests-limit"], 5);
  assert.equal(actions.schedule.interval, "weekly");
  assert.equal(actions.schedule.day, "wednesday");
  assert.ok(actions.groups?.actions);


});

test("PR target validation uses each stack member's own refs", () => {
  const workflow = readFileSync(resolve(".github/workflows/pr-target.yml"), "utf8");
  assert.match(workflow, /\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/);
  assert.match(workflow, /\$\{\{\s*github\.event\.pull_request\.head\.ref\s*\}\}/);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.(?:base_ref|head_ref)\s*\}\}/);
});

test("maintenance scripts preserve Windows process and filesystem semantics", () => {
  const packageSmoke = readFileSync(resolve("scripts/check-package-smoke.mjs"), "utf8");
  const vendorUpstream = readFileSync(resolve("scripts/check-vendor-upstream.mjs"), "utf8");
  assert.match(packageSmoke, /shell:\s*process\.platform === "win32"/);
  assert.match(packageSmoke, /USERPROFILE:\s*scratch/);
  assert.match(vendorUpstream, /shell:\s*process\.platform === "win32"/);
  assert.match(vendorUpstream, /process\.platform === "win32" \? "junction" : "dir"/);

});
