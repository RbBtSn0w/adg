#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { globalPluginsDir, projectPluginsDir } from "../src/paths.ts";
import { COMPONENT_TYPES, type ComponentType } from "../src/types.ts";
import { getAgent, type AgentScope, type AgentSyncResult } from "../src/agents/index.ts";

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
  console.error(`error: ${msg}\n`);
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
    if (r.affected.length > 0) console.log(`${verb} in ${name}: ${r.affected.join(", ")}`);
    else if (r.skipped) console.log(`note: \`${r.agent}\` CLI not found — run \`adg plugins link --target ${r.agent}\` after installing it.`);
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
    console.error(`error: ${err instanceof Error ? err.message : String(err)}\n`);
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

/** Print a plugin's components, each expanded to its member names (verbose view). */
function printContents(contents: Record<string, string[]> | undefined, headerIndent: number): void {
  const entries = (Object.entries(contents ?? {}) as [string, string[]][]).filter(([, names]) => names.length > 0);
  for (const [type, names] of entries) {
    const maxColWidth = Math.max(1, ...names.map((n) => n.length));
    console.log(`${" ".repeat(headerIndent)}${type} (${names.length}):`);
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
    console.error(`error: unknown plugins subcommand: ${rawVerb}\n`);
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
      console.log(`created ${type} at ${res.pluginDir}`);
      for (const f of res.created) console.log(`  + ${f}`);
      return;
    }
    case "adapt": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      for (const r of adaptPlugin(pluginDir, resolveTargets(values.target))) {
        console.log(`adapted ${r.target} -> ${r.file}`);
      }
      return;
    }
    case "validate": {
      const { positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      const res = validatePlugin(pluginDir);
      if (res.ok) {
        console.log(`ok: ${pluginDir} is a valid ADG plugin`);
      } else {
        console.error(`invalid: ${pluginDir}`);
        for (const i of res.issues) console.error(`  - ${i}`);
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
      for (const name of converted) console.log(`converted native manifest -> .agents/.plugin.json: ${name}`);
      if (order.length > 1) console.log(`install order: ${order.join(" -> ")}`);
      for (const res of installed) {
        console.log(`added ${res.name} -> ${res.installedTo}`);
        console.log(`  folderHash: ${res.folderHash}`);
        for (const f of res.adapted) console.log(`  adapted: ${f}`);
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
      console.log(`imported skills into ${res.name} -> ${res.installedTo}`);
      return;
    }
    case "link": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const target = values.target as LinkTarget | undefined;
      if (target !== "claude" && target !== "codex") fail("plugins link requires --target claude|codex");
      const res = linkPlugins({ pluginsDir: resolveScopeDir(values), target, global: Boolean(values.global) });
      for (const a of res.actions) {
        console.log(`linked ${a.name} [${res.target}]${a.linkedTo ? ` -> ${a.linkedTo}` : ""}`);
        for (const f of a.adapted) console.log(`  adapted: ${f}`);
      }
      if (res.cliSkipped) {
        console.log(`note: \`${target}\` CLI not found — manifests were generated, but nothing was enabled in ${target}.`);
      }
      return;
    }
    case "update": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const { results, missing, agents } = updateLock(resolveScopeDir(values), undefined, {
        resync: true,
        scope: scopeOf(values),
      });
      for (const r of results) console.log(`${r.changed ? "updated" : "unchanged"} ${r.name}@${r.version}`);
      for (const m of missing) console.error(`  ! missing directory for locked plugin: ${m}`);
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
      if (res.removedDir) console.log(`removed ${res.name} -> ${res.removedDir}`);
      else console.log(`removed ${res.name} (no directory on disk)`);
      for (const link of res.unlinked) console.log(`  unlinked: ${link}`);
      for (const r of res.agents ?? []) {
        if (r.affected.length > 0) console.log(`  disabled in ${getAgent(r.agent)?.displayName ?? r.agent}`);
      }
      if (!res.removedFromLock && !res.removedDir) {
        console.log(`  ${res.name} was not recorded in the lock`);
      }
      return;
    }
    case "list": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const pluginsDir = resolveScopeDir(values);
      const plugins = listPlugins(pluginsDir);
      if (plugins.length === 0) {
        console.log(`no plugins recorded in ${pluginsDir}`);
        return;
      }
      for (const p of plugins) {
        const partial = p.selection ? "  (partial)" : "";
        console.log(`${p.name}@${p.version}  [${p.origin.type}] ${p.folderHash.slice(0, 19)}${partial}`);
        const entries = (Object.entries(p.contents ?? {}) as [string, string[]][]).filter(([, names]) => names.length > 0);
        if (entries.length === 0) continue;
        if (values.verbose) {
          printContents(p.contents, 2);
        } else {
          console.log(`  ${entries.map(([type, names]) => `${type}: ${names.length}`).join("  ")}`);
        }
      }
      return;
    }
    case "migrate": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const res = migrateLayout(resolveScopeDir(values));
      for (const m of res.moved) console.log(`moved ${m.name}: ${m.from} -> ${m.to}`);
      for (const m of res.missing) console.error(`  ! missing directory for locked plugin: ${m}`);
      if (res.moved.length === 0) console.log(`nothing to migrate (${res.unchanged.length} already in place)`);
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
        console.log("No plugins installed.");
        return;
      }
      // Verbose: drill each plugin down to its components (reuses `plugins list -v`).
      const byName = values.verbose ? new Map(listPlugins(dir).map((p) => [p.name, p])) : undefined;
      for (const g of groups) {
        const ref = g.ref ? `@${g.ref}` : "";
        const n = g.installed.length;
        const tag = g.remote ? "" : "  (local — re-run add to update)";
        console.log(`${g.source}${ref}  (${n} plugin${n !== 1 ? "s" : ""})${tag}`);
        if (byName) {
          for (const name of g.installed) {
            const p = byName.get(name);
            console.log(`  ${name}${p?.selection ? "  (partial)" : ""}`);
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
        console.log(`upgraded ${r.source}: ${r.updated.length} plugin(s)${conv}`);
        for (const p of r.updated) console.log(`  ${p.name} -> ${p.installedTo}`);
        if (r.available.length > 0) {
          console.log(`  ${r.available.length} more available (use --all): ${r.available.join(", ")}`);
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
      console.log(`removed ${res.removed.length} plugin(s) from ${res.source}: ${res.removed.join(", ")}`);
      return;
    }
    default: {
      console.error(`error: unknown marketplace subcommand: ${sub}\n`);
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
function runSkills(verb: string | undefined, rest: string[]): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = join(here, "..", "vendor", "skills", "src", "cli.ts");
  const args = [verb, ...rest].filter((x): x is string => x !== undefined);
  const r = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

async function main(argv: string[]): Promise<void> {
  const [domain, verb, ...rest] = argv;

  if (!domain || domain === "help" || domain === "--help" || domain === "-h") {
    console.log(TOP_USAGE);
    return;
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

main(process.argv.slice(2)).catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
