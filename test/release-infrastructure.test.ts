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

/**
 * Test Intent
 * Risk: a failed GitHub Packages mirror is reported as a successful release.
 * Why Automation: authentication and registry failures share npm's non-zero exit path.
 * Why Existing Tests Insufficient: the release shell script previously had no executable contract test.
 * Chosen Layer: Integration Test - execute the real script with a deterministic npm process boundary.
 * Fragility Analysis: assert exit semantics, not npm wording or shell implementation details.
 * If Omitted: CI can stay green while the required package mirror is absent.
 */
function runMirror(mode: "success" | "duplicate" | "conflict" | "failure"): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "adg-release-script-"));
  try {
    const bin = join(root, "bin");
    const fakeNpm = join(bin, "npm");
    const script = resolve("scripts/publish-github-packages.sh");
    mkdirSync(bin);
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(fakeNpm, `#!/usr/bin/env bash
case "$FAKE_NPM_MODE" in
  success) exit 0 ;;
  duplicate) echo "npm error EPUBLISHCONFLICT version already exists" >&2; exit 1 ;;
  conflict) echo "npm error E409 Conflict: repository policy rejected publish" >&2; exit 1 ;;
  failure) echo "npm error E401 authentication failed" >&2; exit 1 ;;
esac
`);
    chmodSync(fakeNpm, 0o755);
    const result = spawnSync("bash", [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_TOKEN: "test-token",
        FAKE_NPM_MODE: mode,
      },
    });
    return { status: result.status, stderr: String(result.stderr ?? "") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const bashAvailable = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const mirrorTest = (name: string, body: () => void): void => {
  test(name, { skip: bashAvailable ? false : "requires bash to exercise the release script" }, body);
};

mirrorTest("GitHub Packages mirror succeeds when npm publish succeeds", () => {
  assert.equal(runMirror("success").status, 0);
});

mirrorTest("GitHub Packages mirror tolerates an already-published version", () => {
  assert.equal(runMirror("duplicate").status, 0);
});

mirrorTest("GitHub Packages mirror propagates non-duplicate failures", () => {
  const result = runMirror("failure");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication failed/);
});

mirrorTest("GitHub Packages mirror does not treat an arbitrary conflict as a duplicate", () => {
  assert.notEqual(runMirror("conflict").status, 0);
});

/**
 * Test Intent
 * Risk: support and release gates silently disappear during workflow edits.
 * Why Automation: YAML success does not prove the repository runs its declared minimum or packed CLI.
 * Why Existing Tests Insufficient: CI only covered the rolling Node matrix and source layout.
 * Chosen Layer: Integration Test - lock the repository's required gate declarations.
 * Fragility Analysis: assert semantic command/version markers, not YAML ordering.
 * If Omitted: future cleanup can remove a release-critical gate without a failing test.
 */
test("CI covers the minimum Node runtime and repository release gates", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.match(workflow, /node-version:\s*["']?22\.18\.0["']?/);
  assert.match(workflow, /npm run check:docs/);
  assert.match(workflow, /npm run check:package-smoke/);
  assert.match(workflow, /npm run check:vendor-upstream/);
  assert.match(workflow, /npm install -g npm@11\.21\.0/);
  assert.match(workflow, /pr-dev-release:/);
  assert.match(workflow, /--tag next/);
  assert.match(workflow, /Mint release-bot token/);
  assert.match(workflow, /token:\s*\$\{\{\s*steps\.bot\.outputs\.token\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.ok(pkg.scripts?.["check:docs"]);
  assert.ok(pkg.scripts?.["check:package-smoke"]);
  assert.ok(pkg.scripts?.["check:vendor-upstream"]);
});

test("workflows pin third-party actions to immutable commits", () => {
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/sync-main-to-develop.yml",
    ".github/workflows/scheduled-release-pr.yml",
    ".github/workflows/retarget-dependabot.yml",
  ]) {
    const workflow = readFileSync(resolve(file), "utf8");
    const refs = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+)/gm)].map((match) => match[1]!);
    assert.ok(refs.length > 0, `${file} should use at least one action`);
    for (const ref of refs) assert.match(ref, /^[0-9a-f]{40}$/, `${file} contains a mutable action ref: ${ref}`);
  }
});

test("dependabot targets develop and groups dependencies to avoid PR surges", () => {
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
  assert.equal(npm["target-branch"], "develop");
  assert.equal(npm["open-pull-requests-limit"], 5);
  assert.equal(npm.schedule.interval, "weekly");
  assert.equal(npm.schedule.day, "wednesday");
  assert.ok(npm.groups?.opentelemetry);
  assert.ok(npm.groups?.["semantic-release"]);
  assert.ok(npm.groups?.types);
  assert.ok(npm.groups?.dependencies);

  const actions = dependabot.updates.find((u) => u["package-ecosystem"] === "github-actions");
  assert.ok(actions, "github-actions ecosystem entry exists");
  assert.equal(actions["target-branch"], "develop");
  assert.equal(actions["open-pull-requests-limit"], 5);
  assert.equal(actions.schedule.interval, "weekly");
  assert.equal(actions.schedule.day, "wednesday");
  assert.ok(actions.groups?.actions);

  const retargetRaw = readFileSync(resolve(".github/workflows/retarget-dependabot.yml"), "utf8");
  const retarget = YAML.parse(retargetRaw) as {
    on: { pull_request_target?: { types: string[]; branches: string[] }; workflow_dispatch?: unknown };
    jobs: {
      retarget: {
        if: string;
        steps: Array<{ name: string; run?: string }>;
      };
    };
  };

  assert.deepEqual(retarget.on.pull_request_target?.types, ["opened", "reopened", "edited"]);
  assert.deepEqual(retarget.on.pull_request_target?.branches, ["main"]);
  assert.ok(retarget.on.workflow_dispatch !== undefined);
  assert.match(
    retarget.jobs.retarget.if,
    /github\.event_name\s*==\s*['"]workflow_dispatch['"]\s*\|\|\s*github\.event\.pull_request\.user\.login\s*==\s*['"]dependabot\[bot\]['"]/,
  );
  const retargetStep = retarget.jobs.retarget.steps.find((s) => s.name === "Retarget PR to develop");
  assert.ok(retargetStep?.run);
  assert.match(retargetStep.run, /--app\s+dependabot/);
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
  const publish = readFileSync(resolve("scripts/publish-github-packages.sh"), "utf8");
  assert.match(packageSmoke, /shell:\s*process\.platform === "win32"/);
  assert.match(packageSmoke, /USERPROFILE:\s*scratch/);
  assert.match(vendorUpstream, /shell:\s*process\.platform === "win32"/);
  assert.match(vendorUpstream, /process\.platform === "win32" \? "junction" : "dir"/);
  assert.doesNotMatch(publish, /2>\s*>\(/);
  assert.match(publish, /2>\s*"\$publish_log"/);
});
