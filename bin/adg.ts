#!/usr/bin/env node
import { parseArgs } from "node:util";
import pc from "picocolors";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate, formatUpdateNotice } from "../src/update-check.ts";
import { ADAPTER_TARGETS, type AdapterTarget } from "../src/adapters/index.ts";
import { initScaffold, type InitType } from "../src/commands/init.ts";
import { adaptPlugin } from "../src/commands/adapt.ts";
import { addPlugins } from "../src/commands/install.ts";
import { updateLock } from "../src/commands/update.ts";
import { validatePlugin } from "../src/commands/validate.ts";
import { listPlugins } from "../src/commands/list.ts";
import { importSkills } from "../src/commands/import.ts";
import { linkPlugins, type LinkTarget } from "../src/commands/link.ts";
import { removePlugin } from "../src/commands/remove.ts";
import { migrateLayout } from "../src/commands/migrate.ts";
import { marketplaceList, marketplaceRemove, marketplaceUpgrade, type ScopeInfo } from "../src/commands/marketplace.ts";
import { selectTargetsInteractive } from "../src/commands/select-agents.ts";
import { selectPluginsInteractive } from "../src/commands/select-plugins.ts";
import { selectScopeInteractive } from "../src/commands/select-scope.ts";
import { confirmFullInstall, selectComponentsInteractive } from "../src/commands/select-components.ts";
import { globalPluginsDir, installedPluginDir, projectPluginsDir } from "../src/paths.ts";
import { COMPONENT_TYPES, type ComponentType } from "../src/types.ts";
import { agentsForComponents, getAgent, type AgentScope, type AgentSyncResult } from "../src/agents/index.ts";

// ---------------------------------------------------------------------------
// Semantic colors, mirroring `adg skills list` so output reads the same across
// commands: cyan = primary identifiers (plugins, agents, sources), dim =
// secondary metadata (paths, hashes, sub-details), green = success, yellow =
// notes/warnings, red = errors, bold = section titles. picocolors auto-disables
// on non-TTY / NO_COLOR, so piped output and tests stay plain.
// ---------------------------------------------------------------------------
const ui = {
  title: (s: string) => pc.bold(s),
  name: (s: string) => pc.cyan(s),
  meta: (s: string) => pc.dim(s),
  ok: (s: string) => pc.green(s),
  warn: (s: string) => pc.yellow(s),
  err: (s: string) => pc.red(s),
} as const;

// ---------------------------------------------------------------------------
// Single source of truth for flags.
//
// Every flag is declared once here and drives BOTH the argument parser and the
// generated help text, so the two can never drift (the Homebrew `cmd_args`
// idea). A command lists the flag *names* it accepts; parsing and `-h` output
// are both derived from this table.
// ---------------------------------------------------------------------------
type FlagSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  hint?: string; // value placeholder shown in help, e.g. "<dir>"
  help: string; // one-line description
};

const FLAGS: Record<string, FlagSpec> = {
  // Short flags are first-letter aliases. Where several long flags share a
  // first letter, the highest-frequency one wins the short and the rest stay
  // long-only:  d → dir (not description)   a → all (not author/as)
  //             s → skill (not sparse)      p → plugin (not path/project/prefix)
  dir: { type: "string", short: "d", hint: "<dir>", help: "install into an explicit directory" },
  global: { type: "boolean", short: "g", help: "use ~/.agents/plugins (across all projects)" },
  project: { type: "boolean", help: "use <repo>/.agents/plugins (default)" },
  target: { type: "string", short: "t", hint: "claude|codex|all", help: "runtime(s) to adapt for" },
  all: { type: "boolean", short: "a", help: "select all available plugins" },
  plugin: { type: "string", short: "p", multiple: true, hint: "<name>", help: "select a specific plugin (repeatable)" },
  "no-deps": { type: "boolean", short: "n", help: "don't install dependencies" },
  path: { type: "string", hint: "<subdir>", help: "install only this subdir of the source" },
  ref: { type: "string", short: "r", hint: "<ref>", help: "pin a git ref (branch/tag/sha)" },
  sparse: { type: "string", multiple: true, hint: "<path>", help: "sparse-checkout path (repeatable)" },
  "marketplace-name": { type: "string", hint: "<name>", help: "override the marketplace key" },
  force: { type: "boolean", short: "f", help: "skip confirmation / force" },
  description: { type: "string", hint: "<text>", help: "plugin description" },
  author: { type: "string", hint: "<name>", help: "plugin author" },
  type: { type: "string", hint: "plugin|marketplace|all", help: "init: which .agents/ artifact to scaffold (default plugin)" },
  skill: { type: "string", short: "s", multiple: true, hint: "<name>", help: "skill name (init: seed one · add: limit to these)" },
  only: { type: "string", hint: "<types>", help: "limit to these component types (skills,agents,commands,mcp,hooks,apps)" },
  as: { type: "string", hint: "<name>", help: "plugin name to wrap the skills as" },
  prefix: { type: "string", hint: "<p>", help: "prefix imported skill names" },
  verbose: { type: "boolean", short: "v", help: "expand each component to its member names" },
};

type FlagName = keyof typeof FLAGS;

// Parsed flag values, typed once so every command body reads them correctly.
// At runtime a command only sees the flags it declares; the rest are absent.
type ParsedValues = {
  dir?: string;
  global?: boolean;
  project?: boolean;
  target?: string;
  all?: boolean;
  plugin?: string[];
  "no-deps"?: boolean;
  path?: string;
  ref?: string;
  sparse?: string[];
  "marketplace-name"?: string;
  force?: boolean;
  description?: string;
  author?: string;
  skill?: string[];
  type?: string;
  as?: string;
  prefix?: string;
  verbose?: boolean;
  only?: string;
};

// Scope flags recur on almost every command; name the group once.
const SCOPE = ["project", "global", "dir"] as const satisfies readonly FlagName[];

function optionsFor(names: readonly string[]): Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> {
  const out: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  for (const n of names) {
    const f = FLAGS[n as FlagName]!;
    out[n] = { type: f.type, ...(f.short ? { short: f.short } : {}), ...(f.multiple ? { multiple: true } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command table for `adg plugins`.
//
// `summary` feeds the L1 overview (`adg plugins -h`); the rest feeds each
// command's own L2 help (`adg plugins <verb> -h`). `flags` are FLAGS keys.
// ---------------------------------------------------------------------------
type PluginCommand = {
  summary: string;
  synopsis: string;
  positional?: string;
  blurb?: string;
  flags: readonly FlagName[];
  examples?: readonly string[];
  start?: boolean; // tag with "← start here" in the overview
  delegated?: boolean; // handles its own sub-help (marketplace)
};

const PLUGIN_COMMANDS: Record<string, PluginCommand> = {
  add: {
    summary: "install plugins from a source",
    synopsis: "adg plugins add <source>",
    positional: "<source> = <local-dir> | <owner/repo[@ref]> | <github-url>",
    blurb:
      "In a terminal, add guides you through:  scope → plugins → agents → what to install.\n" +
      "By default it installs everything; choose 'No, let me choose' to pick components,\n" +
      "or pass the flags below to skip any prompt (e.g. for scripts/CI).",
    flags: ["all", "plugin", "only", "skill", "target", "no-deps", "path", "ref", "sparse", "marketplace-name", ...SCOPE],
    examples: [
      "adg plugins add owner/repo                 # guided",
      "adg plugins add owner/repo --all --global  # all plugins, global, non-interactive",
      "adg plugins add owner/repo --only skills   # expose only the skills",
      "adg plugins add owner/repo --skill brainstorming --skill writing-plans",
    ],
    start: true,
  },
  list: {
    summary: "list installed plugins",
    synopsis: "adg plugins list",
    blurb: "Each plugin shows a one-line summary of what it contains. Add --verbose\nto expand every component (skills, agents, commands, …) to its member names.",
    flags: ["verbose", ...SCOPE],
  },
  update: {
    summary: "re-sync installed plugins to their sources",
    synopsis: "adg plugins update",
    flags: [...SCOPE],
  },
  remove: {
    summary: "uninstall a plugin",
    synopsis: "adg plugins remove <name>",
    positional: "<name>  an installed plugin name (see `adg plugins list`)",
    flags: ["force", ...SCOPE],
  },
  init: {
    summary: "scaffold a new plugin or marketplace (.agents/ only)",
    synopsis: "adg plugins init <name> [--type plugin|marketplace|all]",
    positional: "<name>  directory name for the new plugin/marketplace",
    flags: ["dir", "description", "author", "skill", "type"],
  },
  adapt: {
    summary: "regenerate Claude/Codex manifests from .agents/.plugin.json",
    synopsis: "adg plugins adapt [<dir>]",
    positional: "<dir>  plugin directory (default: current directory)",
    flags: ["target"],
  },
  validate: {
    summary: "check a directory is a valid ADG plugin",
    synopsis: "adg plugins validate [<dir>]",
    positional: "<dir>  plugin directory (default: current directory)",
    flags: [],
  },
  "import-skills": {
    summary: "wrap an existing skills/ dir as a plugin",
    synopsis: "adg plugins import-skills <skills-dir> --as <name>",
    positional: "<skills-dir>  a directory of SKILL.md folders",
    flags: ["as", "prefix", "description", ...SCOPE],
  },
  link: {
    summary: "link installed plugins into a runtime",
    synopsis: "adg plugins link --target claude|codex",
    flags: ["target", ...SCOPE],
  },
  migrate: {
    summary: "move flat installs into per-marketplace dirs",
    synopsis: "adg plugins migrate",
    flags: [...SCOPE],
  },
  marketplace: {
    summary: "view installed plugins grouped by source",
    synopsis: "adg plugins marketplace <list|upgrade|remove>",
    flags: [],
    delegated: true,
  },
};

// Aliases tolerated for plugin verbs.
const PLUGIN_ALIASES: Record<string, string> = { rm: "remove", mp: "marketplace" };

// ---------------------------------------------------------------------------
// Help rendering (all generated from the tables above).
// ---------------------------------------------------------------------------
const TOP_USAGE = `adg — Agent Directory Group toolkit

Group scattered skills and plugins, by source, into versioned and reproducible
plugin sets — and adapt each to both Claude and Codex runtimes from one manifest.

Quick start:
  adg plugins add <owner/repo>     install plugins from a source (guided in a terminal)
  adg plugins list                 see what's installed

Two domains:
  adg plugins <verb>    manage plugins   (run \`adg plugins -h\`)
  adg skills  <verb>    manage skills    (run \`adg skills -h\`)

Concepts & architecture: see README.md and docs/agents-spec.md`;

function flagLabel(name: FlagName): string {
  const f = FLAGS[name]!;
  const lead = f.short ? `-${f.short}, --${name}` : `    --${name}`;
  return f.hint ? `${lead} ${f.hint}` : lead;
}

function renderFlags(names: readonly FlagName[]): string {
  if (names.length === 0) return "";
  const labels = names.map(flagLabel);
  const width = Math.max(...labels.map((l) => l.length));
  const lines = names.map((n, i) => `  ${labels[i]!.padEnd(width)}  ${FLAGS[n]!.help}`);
  return `Flags:\n${lines.join("\n")}`;
}

/** L1: `adg plugins -h` — overview of the domain and a one-line verb list. */
function renderPluginsHelp(): string {
  const names = Object.keys(PLUGIN_COMMANDS);
  const width = Math.max(...names.map((n) => n.length));
  const rows = names.map((n) => {
    const cmd = PLUGIN_COMMANDS[n]!;
    const tag = cmd.start ? "   ← start here" : "";
    return `  ${n.padEnd(width)}  ${cmd.summary}${tag}`;
  });
  return `adg plugins — manage agent plugins

A plugin bundles skills/agents/commands, installed from a source (a local dir, or
a GitHub repo holding one plugin or many). Authored once in .agents/.plugin.json,
then adapted to Claude and Codex automatically.

Commands  (run \`adg plugins <verb> -h\` for details & flags):
${rows.join("\n")}

Scope (most commands):  --project (default) | --global | --dir <dir>
  --global honors XDG_STATE_HOME / ADG_PLUGINS_HOME. Only the plugins/ subtree is
  touched; AGENTS.md and skills/ are never modified.`;
}

/** L2: `adg plugins <verb> -h` — just this command's region. */
function renderVerbHelp(name: string): string {
  const cmd = PLUGIN_COMMANDS[name]!;
  const parts: string[] = [`adg plugins ${name} — ${cmd.summary}`, "", cmd.synopsis];
  if (cmd.positional) parts.push(`  ${cmd.positional}`);
  if (cmd.blurb) parts.push("", cmd.blurb);
  const flags = renderFlags(cmd.flags);
  if (flags) parts.push("", flags);
  if (cmd.examples) parts.push("", "Examples:", ...cmd.examples.map((e) => `  ${e}`));
  return parts.join("\n");
}

function wantsHelp(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}

function fail(msg: string): never {
  console.error(`${ui.err("error:")} ${msg}\n`);
  console.error(TOP_USAGE);
  process.exit(1);
}

function resolveScopeDir(values: Record<string, unknown>): string {
  if (typeof values.dir === "string") return resolve(values.dir);
  return values.global ? globalPluginsDir() : projectPluginsDir();
}

/** Describe the active scope so "source not found" errors can name where they looked. */
function scopeInfo(values: Record<string, unknown>): ScopeInfo {
  const label = typeof values.dir === "string" ? resolve(values.dir) : values.global ? "global" : "project";
  return { label, globalDir: globalPluginsDir() };
}

/** Map the active scope to an agent install scope (global → user, else project). */
function scopeOf(values: Record<string, unknown>): AgentScope {
  return values.global ? "user" : "project";
}

/** Print per-agent sync outcomes (enabled/disabled/re-synced) generically. */
function reportAgents(agents: AgentSyncResult[] | undefined, verb: string): void {
  for (const r of agents ?? []) {
    const name = getAgent(r.agent)?.displayName ?? r.agent;
    if (r.affected.length > 0) console.log(`${ui.ok(verb)} in ${ui.name(name)}: ${r.affected.join(", ")}`);
    else if (r.skipped) console.log(ui.warn(`note: \`${r.agent}\` CLI not found — run \`adg plugins link --target ${r.agent}\` after installing it.`));
  }
}

function resolveTargets(target: unknown): AdapterTarget[] {
  if (!target || target === "all") return [...ADAPTER_TARGETS];
  if (target === "claude" || target === "codex") return [target];
  fail(`invalid --target "${String(target)}" (expected claude|codex|all)`);
}

/** Parse a `--only skills,commands` list into validated component types. */
function resolveComponents(only: string | undefined): ComponentType[] | undefined {
  if (only === undefined) return undefined;
  const parts = only.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !(COMPONENT_TYPES as readonly string[]).includes(p));
  if (bad.length > 0) fail(`invalid --only "${bad.join(", ")}" (expected ${COMPONENT_TYPES.join("|")})`);
  return parts as ComponentType[];
}

/**
 * Parse a verb's args against only the flags it declares. An unknown flag (or a
 * malformed value) prints that command's own help — so `-h` and a typo lead to
 * the same place. Returns parsed values + positionals.
 */
function parseVerb(name: string, flags: readonly FlagName[], rest: string[]): { values: ParsedValues; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: rest, options: optionsFor(flags), allowPositionals: true });
    return { values: values as ParsedValues, positionals };
  } catch (err) {
    console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(renderVerbHelp(name));
    process.exit(1);
  }
}

/**
 * Lay items out in aligned columns sized to the terminal width (row-major).
 * Items longer than `maxColWidth` are truncated with an ellipsis. Falls back to
 * a single column on narrow terminals. Returns the block as a string.
 */
function formatColumns(
  items: string[],
  opts: { indent?: number; gutter?: number; maxColWidth?: number; width?: number } = {},
): string {
  const indent = opts.indent ?? 2;
  const gutter = opts.gutter ?? 2;
  const maxColWidth = opts.maxColWidth ?? 24;
  const termWidth = opts.width ?? process.stdout.columns ?? 80;

  const cells = items.map((s) => (s.length > maxColWidth ? s.slice(0, maxColWidth - 1) + "…" : s));
  const colWidth = Math.min(Math.max(1, ...cells.map((c) => c.length)), maxColWidth);
  const cols = Math.max(1, Math.floor((termWidth - indent + gutter) / (colWidth + gutter)));

  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    const padded = row.map((c, j) => (j === row.length - 1 ? c : c.padEnd(colWidth)));
    lines.push(" ".repeat(indent) + padded.join(" ".repeat(gutter)));
  }
  return lines.join("\n");
}

/** Abbreviate the home-directory prefix of an absolute path to `~`. */
function abbrevHome(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/** Print a plugin's components, each expanded to its member names (verbose view). */
function printContents(contents: Record<string, string[]> | undefined, headerIndent: number): void {
  const entries = (Object.entries(contents ?? {}) as [string, string[]][]).filter(([, names]) => names.length > 0);
  for (const [type, names] of entries) {
    const maxColWidth = Math.max(1, ...names.map((n) => n.length));
    console.log(`${" ".repeat(headerIndent)}${ui.name(type)} ${ui.meta(`(${names.length}):`)}`);
    console.log(formatColumns(names, { indent: headerIndent + 2, maxColWidth }));
  }
}

async function runPlugins(rawVerb: string | undefined, rest: string[]): Promise<void> {
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
    case "add": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const spec = positionals[0];
      if (!spec) fail("plugins add requires a <plugin-dir | owner/repo[@ref] | github-url>");
      const tty = process.stdin.isTTY;
      // Scope: honor an explicit --dir/--global/--project, else ask in a terminal
      // (defaulting to project non-interactively).
      let global = Boolean(values.global);
      if (!values.dir && values.global === undefined && values.project === undefined && tty) {
        global = await selectScopeInteractive();
      }
      const pluginsDir = values.dir
        ? resolve(values.dir)
        : global
          ? globalPluginsDir()
          : projectPluginsDir();
      // A source may hold one plugin or a whole marketplace. addPlugins discovers
      // all of them; in a terminal the user picks scope, then plugins, then agents,
      // then (unless --only/--skill narrow it) chooses what to install per plugin.
      // --all / --plugin / --path / --only / --skill narrow non-interactively.
      const only = resolveComponents(values.only);
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
        targets: values.target !== undefined ? resolveTargets(values.target) : undefined,
        selectPlugins: tty ? selectPluginsInteractive : undefined,
        selectTargets: tty && values.target === undefined ? selectTargetsInteractive : undefined,
        confirmFull: tty && !narrowed ? confirmFullInstall : undefined,
        selectComponents: tty && !narrowed ? selectComponentsInteractive : undefined,
        // Make the install actually usable in the chosen agents, not just stored.
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
      reportAgents(agents, "enabled");
      return;
    }
    case "import-skills": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const dir = positionals[0];
      if (!dir) fail("plugins import-skills requires a <skills-dir>");
      if (!values.as) fail("plugins import-skills requires --as <plugin-name>");
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
      const { values } = parseVerb(verb, cmd.flags, rest);
      const target = values.target as LinkTarget | undefined;
      if (target !== "claude" && target !== "codex") fail("plugins link requires --target claude|codex");
      const res = linkPlugins({ pluginsDir: resolveScopeDir(values), target, global: Boolean(values.global) });
      for (const a of res.actions) {
        console.log(`${ui.ok("linked")} ${ui.name(a.name)} ${ui.meta(`[${res.target}]`)}${a.linkedTo ? ui.meta(` -> ${a.linkedTo}`) : ""}`);
        for (const f of a.adapted) console.log(ui.meta(`  adapted: ${f}`));
      }
      if (res.cliSkipped) {
        console.log(ui.warn(`note: \`${target}\` CLI not found — manifests were generated, but nothing was enabled in ${target}.`));
      }
      return;
    }
    case "update": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const { results, missing, agents } = updateLock(resolveScopeDir(values), undefined, {
        resync: true,
        scope: scopeOf(values),
      });
      for (const r of results) console.log(`${r.changed ? ui.ok("updated") : ui.meta("unchanged")} ${ui.name(`${r.name}@${r.version}`)}`);
      for (const m of missing) console.error(ui.warn(`  ! missing directory for locked plugin: ${m}`));
      reportAgents(agents, "re-synced");
      return;
    }
    case "remove": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins remove requires a <name>");
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
        if (r.affected.length > 0) console.log(ui.meta(`  disabled in ${getAgent(r.agent)?.displayName ?? r.agent}`));
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
      if (plugins.length === 0) {
        console.log(ui.meta(`no plugins recorded in ${pluginsDir}`));
        return;
      }
      // Pre-compute each plugin's display row so the name/path columns can be
      // aligned across rows (à la `adg skills list`). The `Agents:` column is
      // derived from the exposed component types — which agents can adapt it.
      const PATH_MAX = 44;
      const rows = plugins.map((p) => {
        const exposed = (Object.entries(p.contents ?? {}) as [string, string[]][]).filter(([, names]) => names.length > 0);
        const types = exposed.map(([type]) => type) as ComponentType[];
        const agents = agentsForComponents(types).map((a) => a.displayName);
        return {
          p,
          label: `${p.name}@${p.version}`,
          path: abbrevHome(installedPluginDir(pluginsDir, p.name, p.origin)),
          agents: agents.length > 0 ? agents.join(", ") : "—",
          counts: exposed.map(([type, names]) => `${type}: ${names.length}`),
        };
      });
      const nameW = Math.max(...rows.map((r) => r.label.length));
      const pathW = Math.min(PATH_MAX, Math.max(...rows.map((r) => r.path.length)));
      const ellip = (s: string, w: number) => (s.length > w ? "…" + s.slice(s.length - w + 1) : s);

      // Color mirrors `adg skills list`: cyan name, dim path / dim "Agents:"
      // label with the agent names left bright, and the provenance/counts line
      // fully dimmed as secondary metadata. Widths are measured on the uncolored
      // strings (above), so wrapping the padded text keeps columns aligned.
      // picocolors auto-disables on non-TTY / NO_COLOR, so pipes stay plain.
      for (const r of rows) {
        const partial = r.p.selection ? "  (partial)" : "";
        const name = ui.name(r.label.padEnd(nameW));
        const path = ui.meta(ellip(r.path, pathW).padEnd(pathW));
        console.log(`${name}  ${path}  ${ui.meta("Agents:")} ${r.agents}`);
        const provenance = `[${r.p.origin.type}] ${r.p.folderHash.slice(0, 19)}${partial}`;
        console.log(ui.meta(`  ${[provenance, ...r.counts].join("   ")}`));
        if (values.verbose) printContents(r.p.contents, 4);
      }
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
      return runMarketplace(rest);
  }
}

const MARKETPLACE_USAGE = `adg plugins marketplace — view installed plugins by source, and re-sync

A marketplace is just your installed plugins grouped by where they came from
(no separate registry). You add sources with \`adg plugins add\`; these commands
look back over what you installed.

Commands:
  adg plugins marketplace list [--verbose] [--global | --project | --dir <dir>]
        Group installed plugins by source. --verbose expands each plugin to its
        components (skills, agents, commands, …).
  adg plugins marketplace upgrade [<source>] [--all] [--target claude|codex|all] [--global | --project | --dir <dir>]
        Re-fetch a source and update its installed plugins (--all also installs
        anything new it now offers). No <source> upgrades every remote source.
  adg plugins marketplace remove <source> [--force] [--global | --project | --dir <dir>]
        Uninstall every plugin that came from <source>.

<source> is a key from \`marketplace list\` (e.g. owner/repo).`;

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
      if (groups.length === 0) {
        console.log(ui.meta("No plugins installed."));
        return;
      }
      // Verbose: drill each plugin down to its components (reuses `plugins list -v`).
      const byName = values.verbose ? new Map(listPlugins(dir).map((p) => [p.name, p])) : undefined;
      for (const g of groups) {
        const ref = g.ref ? `@${g.ref}` : "";
        const n = g.installed.length;
        const tag = g.remote ? "" : ui.warn("  (local — re-run add to update)");
        console.log(`${ui.name(`${g.source}${ref}`)}  ${ui.meta(`(${n} plugin${n !== 1 ? "s" : ""})`)}${tag}`);
        if (byName) {
          for (const name of g.installed) {
            const p = byName.get(name);
            console.log(`  ${ui.name(name)}${p?.selection ? ui.meta("  (partial)") : ""}`);
            printContents(p?.contents, 4);
          }
        } else {
          console.log(formatColumns(g.installed));
        }
      }
      return;
    }
    case "upgrade": {
      const { values, positionals } = parseVerb("marketplace", ["all", "target", ...SCOPE], rest);
      const results = await marketplaceUpgrade({
        pluginsDir: resolveScopeDir(values),
        scope: scopeInfo(values),
        activate: true,
        agentScope: scopeOf(values),
        source: positionals[0],
        all: values.all,
        targets: resolveTargets(values.target),
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
      if (!source) fail("marketplace remove requires a <source>");
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
    default: {
      console.error(`${ui.err("error:")} unknown marketplace subcommand: ${sub}\n`);
      console.error(MARKETPLACE_USAGE);
      process.exit(1);
    }
  }
}

/**
 * Delegate to the vendored `skills` CLI (vendor/skills, a fork of
 * vercel-labs/skills — see vendor/skills/PROVENANCE.md). We run its source
 * entry directly under Node's TypeScript support and forward all args/stdio.
 */
/**
 * Args for re-invoking Node on a `.ts` entry. `process.execArgv` is forwarded so
 * the child inherits the parent's Node flags (e.g. --experimental-strip-types,
 * required to run TypeScript directly on Node 22.6–23.5). `execArgv` is a
 * parameter so the forwarding can be tested with a non-empty flag set.
 */
export function skillsChildArgv(
  entry: string,
  args: string[],
  execArgv: string[] = process.execArgv
): string[] {
  return [...execArgv, entry, ...args];
}

function runSkills(verb: string | undefined, rest: string[]): void {
  const self = fileURLToPath(import.meta.url);
  const here = dirname(self);
  // Resolve the vendored CLI with the same extension we ourselves run as: `.ts`
  // when running source directly under Node's type stripping (dev / npm link),
  // `.js` when running the compiled `dist/` output (published install). Node
  // refuses to strip types under node_modules, so the published bin and the
  // vendored entry must both be the built `.js`.
  const ext = self.endsWith(".ts") ? ".ts" : ".js";
  const entry = join(here, "..", "vendor", "skills", "src", `cli${ext}`);
  const args = [verb, ...rest].filter((x): x is string => x !== undefined);
  const r = spawnSync(process.execPath, skillsChildArgv(entry, args), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

/**
 * Read the package version from package.json.
 *
 * Works in both source mode (`bin/adg.ts` → package.json is 1 level up) and
 * compiled mode (`dist/bin/adg.js` → package.json is 2 levels up).
 */
export function getVersion(): string {
  const self = fileURLToPath(import.meta.url);
  // Source: bin/adg.ts  → up 1 level reaches the repo root.
  // Compiled: dist/bin/adg.js → up 2 levels reaches the repo root.
  const up = self.endsWith(".ts") ? ".." : join("..", "..");
  const pkg = JSON.parse(readFileSync(join(dirname(self), up, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<void> {
  const [domain, verb, ...rest] = argv;

  // --version / -v at the root level: print version and exit.
  // Note: `-v` is also the short flag for `--verbose` in subcommands, but only
  // when it appears *after* a domain (e.g. `adg plugins list -v`). Checking
  // argv[0] here means we only intercept `adg -v` / `adg --version`, never
  // a subcommand's own flags.
  if (domain === "--version" || domain === "-v") {
    console.log(getVersion());
    return;
  }

  if (!domain || domain === "help" || domain === "--help" || domain === "-h") {
    console.log(TOP_USAGE);
    return;
  }

  // Check for an available update (reads local cache; schedules a background
  // network refresh when the cache is stale — the refresh uses an unreffed
  // socket so it cannot delay process exit).
  const currentVersion = getVersion();
  const latestVersion = checkForUpdate(currentVersion);
  if (latestVersion) {
    process.stderr.write(formatUpdateNotice(currentVersion, latestVersion));
  }

  switch (domain) {
    case "plugins":
    case "plugin": // tolerated alias
      return runPlugins(verb, rest);
    case "skills":
    case "skill":
      return runSkills(verb, rest);
    default:
      fail(`unknown domain: ${domain} (expected \`plugins\` or \`skills\`)`);
  }
}

// Only run the CLI when executed directly, so the module can be imported by tests.
// `import.meta.url` is already realpath-resolved by Node, but `process.argv[1]`
// is the path as invoked — when the bin is reached through a symlink (e.g.
// `npm link`'s global shim), that path is the unresolved symlink, so a raw
// string compare misses and `main()` never runs. Resolve argv[1] to its
// realpath before comparing so symlinked invocations still start the CLI.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = resolve(entry);
  }
  return fileURLToPath(import.meta.url) === resolved;
}

if (isInvokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
