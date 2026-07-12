import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { adaptPlugin } from "../commands/adapt.ts";
import { addPlugins } from "../commands/install.ts";
import { validatePlugin } from "../commands/validate.ts";
import { listPlugins } from "../commands/list.ts";
import { importSkills } from "../commands/import.ts";
import { inspectSource } from "../commands/inspect.ts";
import { linkPlugins } from "../commands/link.ts";
import { unlinkPlugins } from "../commands/unlink.ts";
import { syncPlugins } from "../commands/sync.ts";
import { removePlugin } from "../commands/remove.ts";
import { disablePlugins, enablePlugins } from "../commands/state.ts";
import { migrateLayout } from "../commands/migrate.ts";
import { pluginStatus } from "../commands/status.ts";
import { cleanPluginCache, pluginCacheStatus, prunePluginCache, restorePluginCache } from "../commands/cache.ts";
import { marketplaceList, marketplaceRemove, marketplaceSync, updatePlugins, type PluginUpdateResult, type ScopeInfo } from "../commands/marketplace.ts";
import { initScaffold, type InitType } from "../commands/init.ts";
import { confirmFullInstall, selectComponentsInteractive } from "../commands/select-components.ts";
import { selectPluginsInteractive } from "../commands/select-plugins.ts";
import { selectTargetsInteractive } from "../commands/select-agents.ts";
import { selectScopeInteractive, selectUpdateScopeInteractive, type UpdateScope } from "../commands/select-scope.ts";
import { globalPluginsDir, projectPluginsDir, lockPath } from "../paths.ts";
import { getAgent, type AgentScope } from "../agents/index.ts";
import { ui } from "../render/ui.ts";
import {
  renderAgentReport,
  renderMarketplaceList,
  renderPluginList,
  renderStatus,
  renderUpdateReport,
} from "../render/plugins.ts";
import { pluginsListJson, pluginsStatusJson, printJson } from "../render/json.ts";
import {
  CACHE_USAGE,
  MARKETPLACE_USAGE,
  PLUGIN_ALIASES,
  PLUGIN_COMMANDS,
  SCOPE,
  fail,
  parseVerb,
  renderPluginsHelp,
  renderVerbHelp,
  requireSingleTarget,
  resolveComponents,
  resolveScopeDir,
  resolveTargets,
  scopeOf,
  wantsHelp,
  type ParsedValues,
  type PluginCommand,
} from "./index.ts";

interface UpdateScopeTarget {
  dir: string;
  agentScope: AgentScope;
  label: string;
  /** Section heading printed before this scope's report (only set for "both"). */
  heading?: string;
}

/**
 * Resolve which scope(s) `plugins update` should refresh, mirroring
 * `adg skills update`: an explicit --dir is a single ad-hoc location; otherwise
 * --project/--global (or both) win, a terminal prompts for project/global/both,
 * and a non-interactive run defaults to project when a project lock exists.
 */
async function resolveUpdateScopes(values: ParsedValues): Promise<UpdateScopeTarget[]> {
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

  // Home==global trap: a "project" (or "both") scope whose store resolves to the
  // global store would re-pin global plugins to the cwd. Collapse to global.
  // Reuse the dirs already resolved above instead of walking the filesystem again.
  if (choice !== "global" && project.dir === global.dir) {
    console.error(
      ui.warn(
        `note: the project store resolves to the global store (${global.dir}); updating global only so plugins aren't pinned to a project (cwd) scope.`,
      ),
    );
    choice = "global";
  }

  if (choice === "both") {
    return [{ ...project, heading: "Project plugins" }, { ...global, heading: "Global plugins" }];
  }
  return [choice === "global" ? global : project];
}

/** Render an update/upgrade result: per-source changes, then per-agent re-sync. */
function printUpdateReport(result: PluginUpdateResult): void {
  for (const line of renderUpdateReport(result)) console.log(line);
  for (const line of renderAgentReport(result.agents, "re-synced")) console.log(line);
}

/** Resolved scope for a mutating verb. */
interface ActionScope {
  pluginsDir: string;
  global: boolean;
  agentScope: AgentScope;
  info: ScopeInfo;
}

/**
 * A "project" store that resolves to the *global* store path is a trap: running
 * a mutating verb there reads the global plugin set but writes the agent install
 * at project scope, pinning it to the cwd (e.g. the home directory). Promote
 * such a case to global. Pure so it is unit-testable.
 */
export function projectStoreIsGlobalTrap(global: boolean, projectDir: string, globalDir: string): boolean {
  return !global && projectDir === globalDir;
}

/**
 * Apply the home==global guard to a chosen scope: a project scope whose store
 * resolves to the global store would pin plugins to the cwd (e.g. the home
 * directory), so warn and promote it to global. Returns the effective global
 * flag. Shared by every scope-resolving verb (add/update plus resolveActionScope)
 * so the guard can't be forgotten on one path. Callers that already resolved the
 * store dirs may pass them in to avoid recomputing the (filesystem-walking)
 * `projectPluginsDir`. Exported for unit testing the promotion side effect.
 */
export function promoteGlobalTrap(
  global: boolean,
  projectDir: string = projectPluginsDir(),
  globalDir: string = globalPluginsDir(),
): boolean {
  if (!projectStoreIsGlobalTrap(global, projectDir, globalDir)) return global;
  console.error(
    ui.warn(
      `note: the project store resolves to the global store (${globalDir}); using --global so plugins aren't pinned to a project (cwd) scope.`,
    ),
  );
  return true;
}

/**
 * Resolve scope for a mutating verb (sync/link/unlink/remove/migrate/…). Unlike
 * the silent `resolveScopeDir`/`scopeOf`, this:
 *   - honors an explicit --dir/--global/--project,
 *   - rejects a contradictory --global + --project (a single-scope projection),
 *   - prompts (project/global) in a terminal when none was given,
 *   - fails in a non-interactive run rather than silently defaulting to project,
 *   - promotes the home==global trap to global with a warning.
 */
async function resolveActionScope(values: ParsedValues, verb: string): Promise<ActionScope> {
  if (typeof values.dir === "string") {
    // --dir is an explicit ad-hoc store; --global still selects the user agent
    // scope (matching the old scopeOf behavior), the trap guard doesn't apply.
    const dir = resolve(values.dir);
    const global = Boolean(values.global);
    return { pluginsDir: dir, global, agentScope: global ? "user" : "project", info: { label: dir, globalDir: globalPluginsDir() } };
  }
  if (values.global && values.project) fail(`plugins ${verb} takes only one of --global / --project`);
  let global: boolean;
  if (values.global) global = true;
  else if (values.project) global = false;
  else if (process.stdin.isTTY) global = await selectScopeInteractive();
  else fail(`plugins ${verb} needs an explicit scope in a non-interactive run: pass --global or --project`);

  // Resolve the store dirs once (projectPluginsDir walks the filesystem) and
  // reuse them for the trap guard, the store path, and the info label.
  const projectDir = projectPluginsDir();
  const globalDir = globalPluginsDir();
  global = promoteGlobalTrap(global, projectDir, globalDir);
  return {
    pluginsDir: global ? globalDir : projectDir,
    global,
    agentScope: global ? "user" : "project",
    info: { label: global ? "global" : "project", globalDir },
  };
}

function resolveVerbTargets(values: ParsedValues, verb: string): ReturnType<typeof resolveTargets> {
  return values.target === "all"
    ? resolveTargets("all")
    : [requireSingleTarget(values.target, verb)];
}

function printCliUnavailableNote(target: string, message: string): void {
  console.log(ui.warn(`note: \`${target}\` CLI not found — ${message}`));
}

/**
 * Top-level dispatcher for `adg plugins <verb>`: render help, resolve aliases,
 * look the verb up in the command table, then hand off to the per-verb handler
 * (or the marketplace sub-dispatcher). Kept free of `spawnSync` so the whole
 * dispatch surface is unit-testable.
 */
export async function runPlugins(rawVerb: string | undefined, rest: string[]): Promise<void> {
  // `adg plugins` (no verb) or an explicit help request → the L1 overview.
  if (rawVerb === undefined || rawVerb === "-h" || rawVerb === "--help" || rawVerb === "help") {
    console.log(renderPluginsHelp());
    return;
  }

  const verb = PLUGIN_ALIASES[rawVerb] ?? rawVerb;
  const cmd = PLUGIN_COMMANDS[verb];
  if (!cmd) {
    console.error(`${ui.err("error:")} unknown plugins subcommand: ${rawVerb}\n`);
    console.error(renderPluginsHelp());
    process.exit(1);
  }

  // `adg plugins <verb> -h` → just this command's help. (marketplace handles
  // its own sub-help, so let it through.)
  if (!cmd.delegated && wantsHelp(rest)) {
    console.log(renderVerbHelp(verb));
    return;
  }

  if (verb === "marketplace") return runMarketplace(rest);
  if (verb === "cache") return runCache(rest);
  return runPluginsVerb(verb, rest, cmd);
}

async function handleAdd(rest: string[], cmd: PluginCommand): Promise<void> {
  const { values, positionals } = parseVerb("add", cmd.flags, rest);
  const spec = positionals[0];
  if (!spec) fail("plugins add requires a <plugin-dir | owner/repo[@ref] | github-url>");
  const tty = process.stdin.isTTY;
  let global = Boolean(values.global);
  if (!values.dir && values.global === undefined && values.project === undefined && tty) {
    global = await selectScopeInteractive();
  }
  if (!values.dir) global = promoteGlobalTrap(global);
  const pluginsDir = values.dir
    ? resolve(values.dir)
    : global
      ? globalPluginsDir()
      : projectPluginsDir();
  const only = resolveComponents(values.only);
  const skillsSubset = values.skill && values.skill.length > 0 ? values.skill : undefined;
  const mcpSubset = values.mcp && values.mcp.length > 0 ? values.mcp : undefined;
  const narrowed = only !== undefined || skillsSubset !== undefined || mcpSubset !== undefined;
  const { order, installed, removed, converted, agents } = await addPlugins({
    spec,
    pluginsDir,
    ref: values.ref,
    sparse: values.sparse,
    all: values.all,
    plugins: values.plugin,
    only,
    skillsSubset,
    mcpSubset,
    withDeps: !values["no-deps"],
    marketplaceName: values["marketplace-name"],
    as: values.as,
    targets: values.target !== undefined ? resolveTargets(values.target) : undefined,
    selectPlugins: tty ? selectPluginsInteractive : undefined,
    selectTargets: tty && values.target === undefined ? selectTargetsInteractive : undefined,
    confirmFull: tty && !narrowed ? confirmFullInstall : undefined,
    selectComponents: tty && !narrowed ? selectComponentsInteractive : undefined,
    activate: true,
    nonInteractive: !tty,
    scope: global ? "user" : "project",
  });
  for (const name of converted) console.log(ui.meta(`converted native manifest -> .agents/.plugin.json: ${name}`));
  for (const name of removed) console.log(`${ui.warn("removed")} ${ui.name(name)}`);
  if (order.length > 1) console.log(ui.meta(`install order: ${order.join(" -> ")}`));
  for (const res of installed) {
    console.log(`${ui.ok("added")} ${ui.name(res.name)} ${ui.meta(`-> ${res.installedTo}`)}`);
    console.log(ui.meta(`  sourceHash: ${res.sourceHash}`));
    console.log(ui.meta(`  installedHash: ${res.installedHash}`));
    for (const f of res.adapted) console.log(ui.meta(`  adapted: ${f}`));
  }
  for (const line of renderAgentReport(agents, "enabled")) console.log(line);
}

async function handleLink(rest: string[], cmd: PluginCommand): Promise<void> {
  const { values, positionals } = parseVerb("link", cmd.flags, rest);
  const targets = resolveVerbTargets(values, "link");
  const sc = await resolveActionScope(values, "link");
  const names = positionals.length > 0 ? positionals : undefined;
  for (const target of targets) {
    const res = linkPlugins({ pluginsDir: sc.pluginsDir, target, global: sc.global, names });
    for (const action of res.actions) {
      console.log(`${ui.ok("linked")} ${ui.name(action.name)} ${ui.meta(`[${res.target}]`)}${action.linkedTo ? ui.meta(` -> ${action.linkedTo}`) : ""}`);
      for (const file of action.adapted) console.log(ui.meta(`  adapted: ${file}`));
    }
    if (res.cliSkipped) printCliUnavailableNote(target, `manifests were generated, but nothing was enabled in ${target}.`);
  }
}

async function handleUnlink(rest: string[], cmd: PluginCommand): Promise<void> {
  const { values, positionals } = parseVerb("unlink", cmd.flags, rest);
  const targets = resolveVerbTargets(values, "unlink");
  const sc = await resolveActionScope(values, "unlink");
  const names = positionals.length > 0 ? positionals : undefined;
  for (const target of targets) {
    const res = unlinkPlugins({ pluginsDir: sc.pluginsDir, target, global: sc.global, names });
    for (const name of res.unlinked) console.log(`${ui.ok("unlinked")} ${ui.name(name)} ${ui.meta(`[${res.target}]`)}`);
    if (res.cliSkipped) {
      printCliUnavailableNote(target, `nothing was unlinked from ${target}.`);
    } else if (res.unlinked.length === 0 && targets.length === 1) {
      console.log(ui.meta(`nothing to unlink from ${target}`));
    }
  }
}

async function handleSync(rest: string[], cmd: PluginCommand): Promise<void> {
  const { values, positionals } = parseVerb("sync", cmd.flags, rest);
  const targets = resolveVerbTargets(values, "sync");
  const sc = await resolveActionScope(values, "sync");
  const names = positionals.length > 0 ? positionals : undefined;
  for (const target of targets) {
    const res = syncPlugins({ pluginsDir: sc.pluginsDir, target, global: sc.global, names });
    for (const action of res.actions) {
      const tail = action.synced ? ui.meta(` -> ${res.target}`) : "";
      console.log(`${ui.ok("synced")} ${ui.name(action.name)} ${ui.meta(`[${res.target}]`)}${tail}`);
    }
    if (res.cliSkipped) printCliUnavailableNote(target, `manifests were regenerated, but nothing was re-synced in ${target}.`);
  }
}

async function handleUpdate(rest: string[], cmd: PluginCommand): Promise<void> {
  const { values, positionals } = parseVerb("update", cmd.flags, rest);
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
      printUpdateReport(result);
    } catch (err) {
      console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function runPluginsVerb(verb: string, rest: string[], cmd: PluginCommand): Promise<void> {
  switch (verb) {
    case "init": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins init requires a <name>");
      const dir = values.dir ? resolve(values.dir) : resolve(process.cwd(), "plugins");
      const type = (values.type ?? "plugin") as InitType;
      if (type !== "plugin" && type !== "marketplace" && type !== "all") {
        fail(`invalid --type "${values.type}" (expected plugin|marketplace|all)`);
      }
      const res = initScaffold({ name, dir, type, description: values.description, author: values.author, skill: values.skill?.[0] });
      console.log(`${ui.ok(`created ${type}`)} at ${ui.name(res.pluginDir)}`);
      for (const f of res.created) console.log(ui.meta(`  + ${f}`));
      return;
    }
    case "adapt": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      for (const r of adaptPlugin(pluginDir, resolveTargets(values.target))) {
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
    case "inspect": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const result = await inspectSource({ spec: positionals[0] ?? process.cwd(), ref: values.ref });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${ui.ok("inspected")} ${ui.name(result.manifest.name)} ${ui.meta(`[${result.kind}] ${result.components.join(", ") || "no components"}`)}`);
      return;
    }
    case "add": {
      await handleAdd(rest, cmd);
      return;
    }
    case "import-skills": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const dir = positionals[0];
      if (!dir) fail("plugins import-skills requires a <skills-dir>");
      if (!values.as) fail("plugins import-skills requires --as <plugin-name>");
      const sc = await resolveActionScope(values, "import-skills");
      const res = importSkills({
        skillsDir: resolve(dir),
        as: values.as,
        prefix: values.prefix,
        pluginsDir: sc.pluginsDir,
        description: values.description,
      });
      console.log(`${ui.ok("imported skills into")} ${ui.name(res.name)} ${ui.meta(`-> ${res.installedTo}`)}`);
      return;
    }
    case "link": {
      await handleLink(rest, cmd);
      return;
    }
    case "disable":
    case "enable": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      if (positionals.length === 0) fail(`plugins ${verb} requires at least one <name>`);
      const sc = await resolveActionScope(values, verb);
      const result = verb === "disable"
        ? disablePlugins({ pluginsDir: sc.pluginsDir, names: positionals, scope: sc.agentScope })
        : enablePlugins({ pluginsDir: sc.pluginsDir, names: positionals, scope: sc.agentScope });
      for (const name of result.order) {
        const changed = result.changed.includes(name);
        console.log(`${changed ? ui.ok(verb === "disable" ? "disabled" : "enabled") : ui.meta("already " + result.state)} ${ui.name(name)}`);
      }
      for (const agent of result.agents) {
        const display = getAgent(agent.agent)?.displayName ?? agent.agent;
        if (agent.affected.length > 0) console.log(ui.meta(`  ${result.state} in ${display}: ${agent.affected.join(", ")}`));
        else if (agent.skipped) console.log(ui.warn(`  ${agent.agent} unavailable — run \`adg plugins sync --target ${agent.agent} ${result.order.join(" ")}\` later`));
      }
      return;
    }
    case "unlink": {
      await handleUnlink(rest, cmd);
      return;
    }
    case "sync": {
      await handleSync(rest, cmd);
      return;
    }
    case "update": {
      await handleUpdate(rest, cmd);
      return;
    }
    case "remove": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins remove requires a <name>");
      const sc = await resolveActionScope(values, "remove");
      const res = removePlugin({
        pluginsDir: sc.pluginsDir,
        name,
        force: values.force,
        deactivate: true,
        scope: sc.agentScope,
      });
      if (res.removedDir) console.log(`${ui.ok("removed")} ${ui.name(res.name)} ${ui.meta(`-> ${res.removedDir}`)}`);
      else console.log(`${ui.ok("removed")} ${ui.name(res.name)} ${ui.meta("(no directory on disk)")}`);
      for (const link of res.unlinked) console.log(ui.meta(`  unlinked: ${link}`));
      for (const r of res.agents ?? []) {
        const display = getAgent(r.agent)?.displayName ?? r.agent;
        if (r.affected.length > 0) console.log(ui.meta(`  disabled in ${display}`));
        // CLI absent → the plugin may still be enabled there; surface the precise
        // repair so a store-deleted plugin can't silently linger in that agent.
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
      if (values.json) {
        printJson(pluginsListJson(plugins, pluginsDir));
        return;
      }
      for (const line of renderPluginList(plugins, pluginsDir, { verbose: values.verbose })) {
        console.log(line);
      }
      return;
    }
    case "status": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const targets = resolveTargets(values.target);
      const pluginsDir = resolveScopeDir(values);
      const scope = scopeOf(values);
      const statuses = pluginStatus({ pluginsDir, scope, targets });
      if (values.json) {
        printJson(pluginsStatusJson(statuses, pluginsDir, scope, targets));
        return;
      }
      for (const line of renderStatus(statuses)) console.log(line);
      return;
    }
    case "migrate": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const sc = await resolveActionScope(values, "migrate");
      const res = migrateLayout(sc.pluginsDir);
      if (res.lockUpgraded) console.log(`${ui.ok("upgraded")} plugin lock to version 3`);
      for (const m of res.moved) console.log(`${ui.ok("moved")} ${ui.name(m.name)}: ${ui.meta(`${m.from} -> ${m.to}`)}`);
      for (const m of res.missing) console.error(ui.warn(`  ! missing directory for locked plugin: ${m}`));
      if (!res.lockUpgraded && res.moved.length === 0) console.log(ui.meta(`nothing to migrate (${res.unchanged.length} already in place)`));
      return;
    }
    // A verb present in PLUGIN_COMMANDS but missing here (other than `marketplace`,
    // routed before this point) is a wiring bug, not user error — fail loudly
    // rather than silently no-op.
    default:
      fail(`unhandled plugins verb: ${verb}`);
  }
}

async function runMarketplace(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  // `marketplace <sub> -h` → the marketplace help (it documents every sub + flags).
  if (sub !== undefined && wantsHelp(rest)) {
    console.log(MARKETPLACE_USAGE);
    return;
  }
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
      // Verbose: drill each plugin down to its components (reuses `plugins list -v`).
      const byName = values.verbose ? new Map(listPlugins(dir).map((p) => [p.name, p])) : undefined;
      for (const line of renderMarketplaceList(groups, byName)) console.log(line);
      return;
    }
    case "upgrade": {
      // Deprecated: a thin alias for `adg plugins update`. It runs the exact same
      // update path (re-fetch + refresh, with the richer changed/unchanged/deleted
      // report) so there is no second implementation to drift.
      console.error(ui.warn("note: `marketplace upgrade` is a deprecated alias for `adg plugins update`."));
      const { values, positionals } = parseVerb("marketplace", ["all", "target", ...SCOPE], rest);
      // Drive the exact same scope resolution + per-scope loop as `plugins update`
      // (project/global/both, with the home==global trap guard) so the deprecated
      // alias can't drift from the verb it aliases. `--target` narrows the runtimes.
      const targets = values.target !== undefined ? resolveTargets(values.target) : undefined;
      for (const sc of await resolveUpdateScopes(values)) {
        if (sc.heading) console.log(`${ui.name(sc.heading)}`);
        // Mirror `plugins update`'s error handling: report a failed re-fetch and
        // exit cleanly rather than throwing to the top-level catch.
        try {
          const result = await updatePlugins({
            pluginsDir: sc.dir,
            scope: { label: sc.label, globalDir: globalPluginsDir() },
            activate: true,
            agentScope: sc.agentScope,
            source: positionals[0],
            all: values.all,
            targets,
          });
          printUpdateReport(result);
        } catch (err) {
          console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    case "remove":
    case "rm": {
      const { values, positionals } = parseVerb("marketplace", ["force", ...SCOPE], rest);
      const source = positionals[0];
      if (!source) fail("marketplace remove requires a <source>");
      const sc = await resolveActionScope(values, "marketplace remove");
      const res = marketplaceRemove({
        pluginsDir: sc.pluginsDir,
        scope: sc.info,
        agentScope: sc.agentScope,
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
      if (!source) fail("marketplace sync requires a <source>");
      const targets = resolveVerbTargets(values, "marketplace sync");
      const sc = await resolveActionScope(values, "marketplace sync");
      for (const target of targets) {
        const res = marketplaceSync({
          pluginsDir: sc.pluginsDir,
          scope: sc.info,
          source,
          target,
          global: sc.global,
        });
        for (const a of res.actions) {
          console.log(`${ui.ok("synced")} ${ui.name(a.name)} ${ui.meta(`[${res.target}]`)}${a.synced ? ui.meta(` -> ${res.target}`) : ""}`);
        }
        if (res.cliSkipped) {
          printCliUnavailableNote(target, `manifests were regenerated, but nothing was re-synced in ${target}.`);
        }
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

async function runCache(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help" || wantsHelp(rest)) {
    console.log(CACHE_USAGE);
    return;
  }
  if (sub === "status") {
    const { values } = parseVerb("cache", [...SCOPE], rest);
    const status = pluginCacheStatus(resolveScopeDir(values));
    console.log(ui.meta(status.root));
    if (status.entries.length === 0) console.log(ui.meta("cache is empty"));
    for (const entry of status.entries) {
      const label = entry.orphan ? ui.warn("orphan") : entry.recovery === "present" ? ui.ok("cached") : ui.warn(entry.recovery ?? "cached");
      console.log(`${label} ${ui.name(entry.name)} ${ui.meta(`${entry.bytes} bytes`)}`);
    }
    console.log(ui.meta(`total: ${status.totalBytes} bytes`));
    return;
  }
  if (sub === "prune") {
    const { values } = parseVerb("cache", [...SCOPE], rest);
    const scope = await resolveActionScope(values, "cache prune");
    const removed = prunePluginCache(scope.pluginsDir);
    console.log(removed.length > 0 ? `${ui.ok("pruned")} ${removed.join(", ")}` : ui.meta("no orphan cache snapshots"));
    return;
  }
  if (sub === "clean") {
    const { values } = parseVerb("cache", ["force", ...SCOPE], rest);
    if (!values.force) fail("cache clean requires --force");
    const scope = await resolveActionScope(values, "cache clean");
    cleanPluginCache(scope.pluginsDir);
    console.log(ui.ok("cache cleaned"));
    return;
  }
  if (sub === "restore") {
    const { values, positionals } = parseVerb("cache", [...SCOPE], rest);
    const scope = await resolveActionScope(values, "cache restore");
    const restored = restorePluginCache(scope.pluginsDir, positionals);
    console.log(restored.length > 0 ? `${ui.ok("restored")} ${restored.join(", ")}` : ui.meta("no source snapshots to restore"));
    return;
  }
  fail(`unknown cache subcommand: ${sub}`);
}
