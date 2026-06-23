import { resolve } from "node:path";
import { adaptPlugin } from "../commands/adapt.ts";
import { addPlugins } from "../commands/install.ts";
import { validatePlugin } from "../commands/validate.ts";
import { listPlugins } from "../commands/list.ts";
import { importSkills } from "../commands/import.ts";
import { linkPlugins } from "../commands/link.ts";
import { unlinkPlugins } from "../commands/unlink.ts";
import { syncPlugins } from "../commands/sync.ts";
import { removePlugin } from "../commands/remove.ts";
import { migrateLayout } from "../commands/migrate.ts";
import { pluginStatus } from "../commands/status.ts";
import { updatePlugins, marketplaceList, marketplaceRemove, marketplaceSync, marketplaceUpgrade } from "../commands/marketplace.ts";
import { initScaffold, type InitType } from "../commands/init.ts";
import { getAgent } from "../agents/index.ts";
import { ui } from "../render/ui.ts";
import {
  renderAgentReport,
  renderMarketplaceList,
  renderPluginList,
  renderStatus,
  renderUpdateReport,
} from "../render/plugins.ts";
import {
  SCOPE,
  fail,
  parseVerb,
  requireSingleTarget,
  resolveComponents,
  resolveScopeDir,
  resolveTargets,
  scopeInfo,
  scopeOf,
  type PluginCommand,
} from "./index.ts";
import { confirmFullInstall, selectComponentsInteractive } from "../commands/select-components.ts";
import { selectPluginsInteractive } from "../commands/select-plugins.ts";
import { selectTargetsInteractive } from "../commands/select-agents.ts";
import { globalPluginsDir, projectPluginsDir, lockPath } from "../paths.ts";
import { selectScopeInteractive, selectUpdateScopeInteractive, type UpdateScope } from "../commands/select-scope.ts";
import { existsSync } from "node:fs";
import type { AgentScope } from "../agents/index.ts";
import type { ParsedValues } from "./index.ts";

export interface UpdateScopeTarget {
  dir: string;
  agentScope: AgentScope;
  label: string;
  /** Section heading printed before this scope's report (only set for "both"). */
  heading?: string;
}

export async function resolveUpdateScopes(values: ParsedValues): Promise<UpdateScopeTarget[]> {
  if (typeof values.dir === "string") {
    const dir = resolve(values.dir);
    return [{ dir, agentScope: "project", label: dir }];
  }
  const project: UpdateScopeTarget = { dir: projectPluginsDir(), agentScope: "project", label: "project" };
  const global: UpdateScopeTarget = { dir: globalPluginsDir(), agentScope: "user", label: "global" };

  let choice: UpdateScope;
  if (values.global && values.project) choice = "both";
  else if (values.global) choice = "global";
  else if (values.project) choice = "project";
  else if (process.stdin.isTTY) choice = await selectUpdateScopeInteractive();
  else choice = existsSync(lockPath(projectPluginsDir())) ? "project" : "global";

  if (choice === "both") {
    return [{ ...project, heading: "Project plugins" }, { ...global, heading: "Global plugins" }];
  }
  return [choice === "global" ? global : project];
}

export async function runPluginsHandler(verb: string, rest: string[], cmd: PluginCommand, TOP_USAGE: string): Promise<void> {
  switch (verb) {
    case "init": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins init requires a <name>", TOP_USAGE);
      const dir = values.dir ? resolve(values.dir) : resolve(process.cwd(), "plugins");
      const type = (values.type ?? "plugin") as InitType;
      if (type !== "plugin" && type !== "marketplace" && type !== "all") {
        fail(`invalid --type "${values.type}" (expected plugin|marketplace|all)`, TOP_USAGE);
      }
      const res = initScaffold({ name, dir, type, description: values.description, author: values.author, skill: values.skill?.[0] });
      console.log(`${ui.ok(`created ${type}`)} at ${ui.name(res.pluginDir)}`);
      for (const f of res.created) console.log(ui.meta(`  + ${f}`));
      return;
    }
    case "adapt": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      for (const r of adaptPlugin(pluginDir, resolveTargets(values.target, TOP_USAGE))) {
        console.log(`${ui.ok("adapted")} ${ui.name(r.target)} ${ui.meta(`-> ${r.file}`)}`);
      }
      return;
    }
    case "validate": {
      const { positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      const res = validatePlugin(pluginDir);
      if (res.ok) {
        console.log(`${ui.ok("ok:")} ${ui.name(pluginDir)} is a valid ADG plugin`);
      } else {
        console.error(`${ui.err("invalid:")} ${ui.name(pluginDir)}`);
        for (const i of res.issues) console.error(ui.warn(`  - ${i}`));
        process.exit(1);
      }
      return;
    }
    case "add": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const spec = positionals[0];
      if (!spec) fail("plugins add requires a <plugin-dir | owner/repo[@ref] | github-url>", TOP_USAGE);
      const tty = process.stdin.isTTY;
      let global = Boolean(values.global);
      if (!values.dir && values.global === undefined && values.project === undefined && tty) {
        global = await selectScopeInteractive();
      }
      const pluginsDir = values.dir
        ? resolve(values.dir)
        : global
          ? globalPluginsDir()
          : projectPluginsDir();
      const only = resolveComponents(values.only, TOP_USAGE);
      const skillsSubset = values.skill && values.skill.length > 0 ? values.skill : undefined;
      const narrowed = only !== undefined || skillsSubset !== undefined;
      const { order, installed, converted, agents } = await addPlugins({
        spec,
        pluginsDir,
        ref: values.ref,
        sparse: values.sparse,
        path: values.path,
        all: values.all,
        plugins: values.plugin,
        only,
        skillsSubset,
        withDeps: !values["no-deps"],
        marketplaceName: values["marketplace-name"],
        targets: values.target !== undefined ? resolveTargets(values.target, TOP_USAGE) : undefined,
        selectPlugins: tty ? selectPluginsInteractive : undefined,
        selectTargets: tty && values.target === undefined ? selectTargetsInteractive : undefined,
        confirmFull: tty && !narrowed ? confirmFullInstall : undefined,
        selectComponents: tty && !narrowed ? selectComponentsInteractive : undefined,
        activate: true,
        scope: global ? "user" : "project",
      });
      for (const name of converted) console.log(ui.meta(`converted native manifest -> .agents/.plugin.json: ${name}`));
      if (order.length > 1) console.log(ui.meta(`install order: ${order.join(" -> ")}`));
      for (const res of installed) {
        console.log(`${ui.ok("added")} ${ui.name(res.name)} ${ui.meta(`-> ${res.installedTo}`)}`);
        console.log(ui.meta(`  folderHash: ${res.folderHash}`));
        for (const f of res.adapted) console.log(ui.meta(`  adapted: ${f}`));
      }
      for (const line of renderAgentReport(agents, "enabled")) console.log(line);
      return;
    }
    case "import-skills": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const dir = positionals[0];
      if (!dir) fail("plugins import-skills requires a <skills-dir>", TOP_USAGE);
      if (!values.as) fail("plugins import-skills requires --as <plugin-name>", TOP_USAGE);
      const res = importSkills({
        skillsDir: resolve(dir),
        as: values.as,
        prefix: values.prefix,
        pluginsDir: resolveScopeDir(values),
        description: values.description,
      });
      console.log(`${ui.ok("imported skills into")} ${ui.name(res.name)} ${ui.meta(`-> ${res.installedTo}`)}`);
      return;
    }
    case "link": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const target = requireSingleTarget(values.target, "link", TOP_USAGE);
      const names = positionals.length > 0 ? positionals : undefined;
      const res = linkPlugins({ pluginsDir: resolveScopeDir(values), target, global: Boolean(values.global), names });
      for (const a of res.actions) {
        console.log(`${ui.ok("linked")} ${ui.name(a.name)} ${ui.meta(`[${res.target}]`)}${a.linkedTo ? ui.meta(` -> ${a.linkedTo}`) : ""}`);
        for (const f of a.adapted) console.log(ui.meta(`  adapted: ${f}`));
      }
      if (res.cliSkipped) {
        console.log(ui.warn(`note: \`${target}\` CLI not found — manifests were generated, but nothing was enabled in ${target}.`));
      }
      return;
    }
    case "unlink": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const target = requireSingleTarget(values.target, "unlink", TOP_USAGE);
      const names = positionals.length > 0 ? positionals : undefined;
      const res = unlinkPlugins({ pluginsDir: resolveScopeDir(values), target, global: Boolean(values.global), names });
      for (const name of res.unlinked) console.log(`${ui.ok("unlinked")} ${ui.name(name)} ${ui.meta(`[${res.target}]`)}`);
      if (res.cliSkipped) {
        console.log(ui.warn(`note: \`${target}\` CLI not found — nothing was unlinked from ${target}.`));
      } else if (res.unlinked.length === 0) {
        console.log(ui.meta(`nothing to unlink from ${target}`));
      }
      return;
    }
    case "sync": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const target = requireSingleTarget(values.target, "sync", TOP_USAGE);
      const names = positionals.length > 0 ? positionals : undefined;
      const res = syncPlugins({ pluginsDir: resolveScopeDir(values), target, global: Boolean(values.global), names });
      for (const a of res.actions) {
        const tail = a.synced ? ui.meta(` -> ${res.target}`) : "";
        console.log(`${ui.ok("synced")} ${ui.name(a.name)} ${ui.meta(`[${res.target}]`)}${tail}`);
      }
      if (res.cliSkipped) {
        console.log(ui.warn(`note: \`${target}\` CLI not found — manifests were regenerated, but nothing was re-synced in ${target}.`));
      }
      return;
    }
    case "update": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const source = positionals[0];
      for (const sc of await resolveUpdateScopes(values)) {
        if (sc.heading) console.log(`${ui.name(sc.heading)}`);
        try {
          const result = await updatePlugins({
            pluginsDir: sc.dir,
            source,
            all: values.all,
            activate: true,
            agentScope: sc.agentScope,
            scope: { label: sc.label, globalDir: globalPluginsDir() },
          });
          for (const line of renderUpdateReport(result)) console.log(line);
          for (const line of renderAgentReport(result.agents, "re-synced")) console.log(line);
        } catch (err) {
          console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    case "remove": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins remove requires a <name>", TOP_USAGE);
      const res = removePlugin({
        pluginsDir: resolveScopeDir(values),
        name,
        force: values.force,
        deactivate: true,
        scope: scopeOf(values),
      });
      if (res.removedDir) console.log(`${ui.ok("removed")} ${ui.name(res.name)} ${ui.meta(`-> ${res.removedDir}`)}`);
      else console.log(`${ui.ok("removed")} ${ui.name(res.name)} ${ui.meta("(no directory on disk)")}`);
      for (const link of res.unlinked) console.log(ui.meta(`  unlinked: ${link}`));
      for (const r of res.agents ?? []) {
        const display = getAgent(r.agent)?.displayName ?? r.agent;
        if (r.affected.length > 0) console.log(ui.meta(`  disabled in ${display}`));
        else if (r.skipped) {
          console.log(ui.warn(`  ${r.agent} CLI not found — if enabled there, run \`adg plugins unlink --target ${r.agent} ${res.name}\``));
        }
      }
      if (!res.removedFromLock && !res.removedDir) {
        console.log(ui.warn(`  ${res.name} was not recorded in the lock`));
      }
      return;
    }
    case "list": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const pluginsDir = resolveScopeDir(values);
      const plugins = listPlugins(pluginsDir);
      for (const line of renderPluginList(plugins, pluginsDir, { verbose: values.verbose })) {
        console.log(line);
      }
      return;
    }
    case "status": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const targets = values.target !== undefined ? resolveTargets(values.target, TOP_USAGE) : undefined;
      const statuses = pluginStatus({ pluginsDir: resolveScopeDir(values), scope: scopeOf(values), targets });
      for (const line of renderStatus(statuses)) console.log(line);
      return;
    }
    case "migrate": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const res = migrateLayout(resolveScopeDir(values));
      for (const m of res.moved) console.log(`${ui.ok("moved")} ${ui.name(m.name)}: ${ui.meta(`${m.from} -> ${m.to}`)}`);
      for (const m of res.missing) console.error(ui.warn(`  ! missing directory for locked plugin: ${m}`));
      if (res.moved.length === 0) console.log(ui.meta(`nothing to migrate (${res.unchanged.length} already in place)`));
      return;
    }
    case "marketplace":
      // Delegated to runMarketplaceHandler
      return;
  }
}

export async function runMarketplaceHandler(sub: string | undefined, rest: string[], MARKETPLACE_USAGE: string, TOP_USAGE: string): Promise<void> {
  switch (sub) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(MARKETPLACE_USAGE);
      return;
    case "list": {
      const { values } = parseVerb("marketplace", ["verbose", ...SCOPE], rest);
      const dir = resolveScopeDir(values);
      const groups = marketplaceList({ pluginsDir: dir });
      const byName = values.verbose ? new Map(listPlugins(dir).map((p) => [p.name, p])) : undefined;
      for (const line of renderMarketplaceList(groups, byName)) console.log(line);
      return;
    }
    case "upgrade": {
      console.error(ui.warn("note: `marketplace upgrade` is a deprecated alias for `adg plugins update`."));
      const { values, positionals } = parseVerb("marketplace", ["all", "target", ...SCOPE], rest);
      const results = await marketplaceUpgrade({
        pluginsDir: resolveScopeDir(values),
        scope: scopeInfo(values),
        activate: true,
        agentScope: scopeOf(values),
        source: positionals[0],
        all: values.all,
        targets: resolveTargets(values.target, TOP_USAGE),
      });
      for (const r of results) {
        const conv = r.converted.length ? ` (${r.converted.length} converted from native)` : "";
        console.log(`${ui.ok("upgraded")} ${ui.name(r.source)}: ${r.updated.length} plugin(s)${ui.meta(conv)}`);
        for (const p of r.updated) console.log(`  ${ui.name(p.name)} ${ui.meta(`-> ${p.installedTo}`)}`);
        if (r.available.length > 0) {
          console.log(ui.meta(`  ${r.available.length} more available (use --all): ${r.available.join(", ")}`));
        }
      }
      return;
    }
    case "remove":
    case "rm": {
      const { values, positionals } = parseVerb("marketplace", ["force", ...SCOPE], rest);
      const source = positionals[0];
      if (!source) fail("marketplace remove requires a <source>", TOP_USAGE);
      const res = marketplaceRemove({
        pluginsDir: resolveScopeDir(values),
        scope: scopeInfo(values),
        agentScope: scopeOf(values),
        source,
        force: values.force,
        deactivate: true,
      });
      console.log(`${ui.ok("removed")} ${res.removed.length} plugin(s) from ${ui.name(res.source)}: ${res.removed.join(", ")}`);
      return;
    }
    case "sync": {
      const { values, positionals } = parseVerb("marketplace", ["target", ...SCOPE], rest);
      const source = positionals[0];
      if (!source) fail("marketplace sync requires a <source>", TOP_USAGE);
      const target = requireSingleTarget(values.target, "marketplace sync", TOP_USAGE);
      const res = marketplaceSync({
        pluginsDir: resolveScopeDir(values),
        scope: scopeInfo(values),
        source,
        target,
        global: Boolean(values.global),
      });
      for (const a of res.actions) {
        console.log(`${ui.ok("synced")} ${ui.name(a.name)} ${ui.meta(`[${res.target}]`)}${a.synced ? ui.meta(` -> ${res.target}`) : ""}`);
      }
      if (res.cliSkipped) {
        console.log(ui.warn(`note: \`${target}\` CLI not found — manifests were regenerated, but nothing was re-synced in ${target}.`));
      }
      return;
    }
    default: {
      console.error(`${ui.err("error:")} unknown marketplace subcommand: ${sub}\n`);
      console.error(MARKETPLACE_USAGE);
      process.exit(1);
    }
  }
}
