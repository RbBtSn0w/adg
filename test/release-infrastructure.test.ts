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
    const plugin = name => config.plugins.find(p => Array.isArray(p) && (p[0] === name || p[0].endsWith(name === '@semantic-release/commit-analyzer' ? '/release-commit-analyzer.mjs' : '/release-notes-generator.mjs')))[1];
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
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string>; engines: { node: string } };
  assert.equal(pkg.engines.node, "^22.22.2 || ^24.15.0 || >=26");
  const lock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  const jobs = YAML.parse(workflow).jobs;
  const versions = jobs.test.strategy.matrix.include.map((entry: { "node-version": string | number }) => String(entry["node-version"]));
  assert.ok(versions.includes("22.22.2"));
  assert.ok(versions.includes("24.15.0"));
  assert.ok(versions.every((version: string) => ["22.22.2", "24.15.0", "24", "26"].includes(version)));
  for (const file of [".github/workflows/ci.yml", ".github/workflows/pr-commit-semantics.yml"]) {
    const definition = YAML.parse(readFileSync(file, "utf8"));
    for (const job of Object.values(definition.jobs) as Array<{ steps: Array<{ uses?: string; run?: string; if?: string }> }>) {
      if (!job.steps.some(step => step.uses?.startsWith("actions/setup-node@"))) continue;
      const bootstrap = job.steps.find(step => step.run?.includes("npm@12.2.2"));
      assert.ok(bootstrap, `${file} must select npm 12`);
      assert.equal(bootstrap.if, undefined, "all CI matrix entries use npm 12");
      assert.match(bootstrap.run!, /--prefix "\$RUNNER_TEMP\/release-npm"/);
    }
  }
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
    ".github/workflows/pr-preview-publish.yml",
    ".github/workflows/release.yml",
    ".github/workflows/pr-commit-semantics.yml",
  ]) {
    const workflow = readFileSync(resolve(file), "utf8");
    const refs = [...workflow.matchAll(/^\s*uses:\s*[^\s@]+@([^\s#]+)/gm)].map((match) => match[1]!);
    assert.ok(refs.length > 0, `${file} should use at least one action`);
    for (const ref of refs) assert.match(ref, /^[0-9a-f]{40}$/, `${file} contains a mutable action ref: ${ref}`);
  }
});

test("PR previews package the exact head after CI and expose only a verification artifact", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const preview = workflow.jobs["pr-preview"];
  assert.ok(preview, "CI must expose a PR preview package");
  assert.equal(preview.if, "github.event_name == 'pull_request'");
  assert.equal(preview.needs, "test");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(preview.permissions, undefined);
  const steps = preview.steps;
  const checkout = steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const pack = steps.findIndex((step: { id?: string }) => step.id === "pack");
  const upload = steps.findIndex((step: { id?: string }) => step.id === "preview");
  assert.ok(pack >= 0 && upload > pack);
  assert.match(steps[pack].run, /git rev-parse HEAD/);
  assert.ok(steps[pack].run.includes('${PR_HEAD:0:7}'));
  assert.ok(steps[pack].run.includes('^0[0-9]{6}$'));
  assert.match(steps[pack].run, /npm run test:package/);
  assert.match(steps[pack].run, /shasum -a 256/);
  assert.match(steps[upload].uses, /^actions\/upload-artifact@/);
  assert.equal(steps[upload].with["if-no-files-found"], "error");
  assert.match(steps[upload].with.name, /github.event.pull_request.head.sha/);
  assert.match(steps[upload].with.name, /github.run_attempt/);
  const panel = steps.at(-1).run;
  assert.match(panel, /Download the preview ZIP[\s\S]*Run without installing[\s\S]*npm exec --yes --package=\.\/adg-pr-preview\.tgz/);
  assert.match(panel, /Install globally[\s\S]*npm install -g \.\/adg-pr-preview\.tgz/);
  assert.match(panel, /<details>[\s\S]*gh run download[\s\S]*shasum -a 256 -c SHA256SUMS/);
  assert.match(panel, /GITHUB_STEP_SUMMARY/);
});

test("PR preview announcements update one bot comment for the current head", async () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const announcement = workflow.jobs["pr-preview-comment"];
  assert.ok(announcement, "CI must announce the preview in the PR conversation");
  assert.equal(announcement.needs, "pr-preview");
  assert.match(announcement.if, /head\.repo\.full_name == github\.repository/);
  assert.deepEqual(announcement.permissions, { "pull-requests": "write" });
  assert.equal(announcement.steps.length, 1);
  assert.match(announcement.steps[0].uses, /^actions\/github-script@/);
  const script = announcement.steps[0].with.script;
  const run = new Function("github", "context", "core", "process", `return (async () => {${script}\n})();`);
  const sha = "a".repeat(40);
  const panel = `### PR dev preview\n\n- PR head commit: \`${sha}\`\n`;
  const marker = "<!-- adg-pr-dev-preview -->";
  const bot = { login: "github-actions[bot]" };
  for (const [head, existing, expected] of [
    [sha, { id: 9, body: marker, user: { login: "contributor" } }, "create"],
    [sha, { id: 9, body: marker, user: bot }, "update"],
    ["b".repeat(40), { id: 9, body: marker, user: bot }, undefined],
  ] as const) {
    const writes: Array<{ verb: string; body: string; comment_id?: number }> = [];
    const github = {
      paginate: async () => [existing],
      rest: {
        pulls: { get: async () => ({ data: { state: "open", head: { sha: head } } }) },
        issues: {
          listComments() {},
          createComment: async (args: { body: string }) => writes.push({ verb: "create", ...args }),
          updateComment: async (args: { body: string; comment_id: number }) => writes.push({ verb: "update", ...args }),
        },
      },
    };
    await run(github, { repo: { owner: "example", repo: "adg" }, issue: { number: 197 }, payload: { pull_request: { head: { sha } } } },
      { notice() {} }, { env: { PREVIEW_PANEL: panel } });
    assert.deepEqual(writes.map(write => write.verb), expected ? [expected] : []);
    if (expected) assert.equal(writes[0]?.body, `${marker}\n${panel}`);
    if (expected === "update") assert.equal(writes[0]?.comment_id, 9);
  }
});

test("the registry preview publisher selects the current head's verified artifact from a successful CI run", async () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/pr-preview-publish.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_run_id.required, true);
  assert.deepEqual(workflow.permissions, {});
  const { publish, announce } = workflow.jobs;
  const gate = publish.if.replace(/\s+/g, " ").trim();
  assert.equal(gate, "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && vars.RELEASE_ENABLED == 'true'");
  assert.equal(publish.permissions["id-token"], "write");
  assert.equal(publish.permissions.packages, "write");
  assert.equal(announce.permissions["id-token"], undefined);
  assert.ok(publish.steps.every((step: { uses?: string }) => !step.uses?.startsWith("actions/checkout@")));
  const download = publish.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ steps.source.outputs.artifact }}");
  assert.equal(download.with["run-id"], "${{ inputs.source_run_id }}");
  assert.equal(download.with["merge-multiple"], true);
  const sourceStep = publish.steps.find((step: { id?: string }) => step.id === "source");
  assert.equal(sourceStep.env.SOURCE_RUN_ID, "${{ inputs.source_run_id }}");
  const verify = publish.steps.find((step: { id?: string }) => step.id === "verify");
  assert.ok(verify.run.includes('${PR_HEAD:0:7}'));
  assert.match(verify.run, /npm publish \.\/adg-pr-preview\.tgz --ignore-scripts --access public --tag next --registry "\$registry"/);
  assert.match(verify.run, /test "\$integrity" = "\$PREVIEW_INTEGRITY"/);
  const npm = publish.steps.find((step: { id?: string }) => step.id === "npm");
  const mirror = publish.steps.find((step: { id?: string }) => step.id === "mirror");
  assert.match(npm.run, /https:\/\/registry\.npmjs\.org$/m);
  assert.match(mirror.run, /https:\/\/npm\.pkg\.github\.com$/m);
  assert.equal(npm.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(mirror.env.NODE_AUTH_TOKEN, "${{ github.token }}");
  assert.equal(announce.if, "needs.publish.outputs.npm == 'true' || needs.publish.outputs.github-packages == 'true'");

  const run = new Function("github", "context", "core", "process", `return (async () => {${sourceStep.with.script}\n})();`);
  const sha = "a".repeat(40);
  const name = `adg-pr-198-${sha}-attempt-2`;
  for (const stale of [false, true]) {
    const outputs: Record<string, string | number> = {};
    const github = {
      paginate: async () => [{ id: 7, name, expired: false }, { id: 8, name: name.replace(/2$/, "1"), expired: false }],
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            assert.equal(run_id, 11);
            return { data: {
              id: 11, path: ".github/workflows/ci.yml", event: "pull_request", conclusion: "success", run_attempt: 2,
              repository: { full_name: "example/adg" },
              head_sha: sha, head_repository: { id: 13, full_name: "example/adg" },
              pull_requests: [{ number: 198, head: { sha } }],
            } };
          },
          listWorkflowRunArtifacts() {},
        },
        pulls: { get: async () => ({ data: {
          state: "open", base: { ref: "main", repo: { id: 13 } },
          head: { sha: stale ? "b".repeat(40) : sha, repo: { id: 13 } },
        } }) },
      },
    };
    await run(github, { repo: { owner: "example", repo: "adg" } },
      { notice() {}, setOutput(key: string, value: string | number) { outputs[key] = value; } },
      { env: { SOURCE_RUN_ID: "11" } });
    assert.deepEqual(outputs, stale ? {} : { number: 198, head: sha, artifact: 7 });
  }
});

test("the released preview card lists and gives commands for available registries", async () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/pr-preview-publish.yml", "utf8"));
  const script = workflow.jobs.announce.steps[0].with.script;
  const run = new Function("github", "context", "process", `return (async () => {${script}\n})();`);
  const head = "b8c43a6" + "a".repeat(33);
  const version = "0.10.1-dev.pr152.b8c43a6";
  for (const [npm, mirror, stale] of [[true, true, false], [true, false, false], [false, true, false], [false, false, false], [true, true, true]]) {
    const cards: string[] = [];
    const github = {
      paginate: async () => [{ id: 9, user: { login: "github-actions[bot]" }, body: "<!-- adg-pr-dev-preview -->" }],
      rest: {
        pulls: { get: async () => ({ data: { state: "open", head: { sha: stale ? "b".repeat(40) : head } } }) },
        issues: {
          listComments() {},
          updateComment: async ({ body, comment_id }: { body: string; comment_id: number }) => {
            assert.equal(comment_id, 9);
            cards.push(body);
          },
        },
      },
    };
    await run(github, { repo: { owner: "example", repo: "adg" } },
      { env: { PR_NUMBER: "152", PR_HEAD: head, SOURCE_RUN_ID: "11", ARTIFACT_ID: "7", VERSION: version,
        NPM_AVAILABLE: String(npm), MIRROR_AVAILABLE: String(mirror) } });
    assert.equal(cards.length, (npm || mirror) && !stale ? 1 : 0);
    if (cards.length === 0) continue;
    const card = cards[0]!;
    assert.match(card, /PR Dev Preview Released/);
    assert.ok(card.includes("/commit/" + head));
    assert.ok(card.includes("/actions/runs/11/artifacts/7"));
    assert.equal(card.includes("| **npm** |"), npm);
    assert.equal(card.includes("| **GitHub Packages** |"), mirror);
    assert.equal(card.includes(`npx @rbbtsn0w/adg@${version} --version`), npm);
    assert.equal(card.includes(`adg update --tag ${version}`), npm);
    assert.equal(card.includes("adg update --dev"), npm);
    assert.equal(card.includes(`npm install -g @rbbtsn0w/adg@${version}`), npm);
    assert.equal(card.includes(`npm install -g --registry=https://npm.pkg.github.com @rbbtsn0w/adg@${version}`), !npm && mirror);
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
