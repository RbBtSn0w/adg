import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { globalPluginsDir, projectPluginsDir } from "../paths.ts";
import { ADAPTER_TARGETS, type AdapterTarget } from "../adapters/index.ts";
import { COMPONENT_TYPES, type ComponentType } from "../types.ts";
import type { AgentScope } from "../agents/index.ts";
import type { ScopeInfo } from "../commands/marketplace.ts";
import { ui } from "../render/ui.ts";

export type FlagSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  hint?: string;
  help: string;
};

export const FLAGS: Record<string, FlagSpec> = {
  dir: { type: "string", short: "d", hint: "<dir>", help: "install into an explicit directory" },
  global: { type: "boolean", short: "g", help: "use ~/.agents/plugins (across all projects)" },
  project: { type: "boolean", help: "use <repo>/.agents/plugins (default)" },
  target: { type: "string", short: "t", hint: "claude|codex|antigravity|all", help: "runtime(s) to adapt for" },
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

export type FlagName = keyof typeof FLAGS;

export type ParsedValues = {
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

export const SCOPE = ["project", "global", "dir"] as const satisfies readonly FlagName[];

export function optionsFor(names: readonly string[]): Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> {
  const out: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  for (const n of names) {
    const f = FLAGS[n as FlagName]!;
    out[n] = { type: f.type, ...(f.short ? { short: f.short } : {}), ...(f.multiple ? { multiple: true } : {}) };
  }
  return out;
}

export type PluginCommand = {
  summary: string;
  synopsis: string;
  positional?: string;
  blurb?: string;
  flags: readonly FlagName[];
  examples?: readonly string[];
  start?: boolean;
  delegated?: boolean;
};

export const PLUGIN_COMMANDS: Record<string, PluginCommand> = {
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
  status: {
    summary: "show store-vs-agent drift per runtime",
    synopsis: "adg plugins status [--target claude|codex|antigravity]",
    blurb: "Query each agent's CLI live and diff it against the store: what's in\nsync, missing (needs `link`/`sync`), or present in the agent only. Each drift\nrow carries the command that repairs it. Inspects the active scope (--global →\nuser, else project). Name-level only — run `sync` if unsure.",
    flags: ["target", ...SCOPE],
  },
  update: {
    summary: "pull upstream changes for installed plugins",
    synopsis: "adg plugins update [<source>]",
    positional: "<source>  limit to one source key from `adg plugins marketplace list` (default: all)",
    blurb:
      "Re-fetches every remote source and refreshes the plugins installed from it,\n" +
      "reporting what changed, what's unchanged, what was deleted upstream, and what's\n" +
      "newly available (install those too with --all). Local-source plugins are\n" +
      "rescanned in place. In a terminal, it asks whether to update project, global,\n" +
      "or both; pass a scope flag to skip the prompt.\n\n" +
      "This is the plugins-domain twin of `adg skills update`.",
    flags: ["all", ...SCOPE],
    examples: [
      "adg plugins update                      # guided: project / global / both",
      "adg plugins update --global             # every global source",
      "adg plugins update owner/repo           # just one source",
      "adg plugins update owner/repo --all     # also install newly-added plugins",
    ],
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
    synopsis: "adg plugins link --target claude|codex|antigravity [name...]",
    positional: "[name...]  installed plugin names to link (default: all)",
    blurb: "Project the store into one agent: (re)generate its manifests and enable\nthe plugins via that agent's CLI. The store is unchanged. The inverse is\n`adg plugins unlink`; to force an agent to match the store, use `adg plugins sync`.",
    flags: ["target", ...SCOPE],
  },
  unlink: {
    summary: "unlink plugins from a runtime (store kept)",
    synopsis: "adg plugins unlink --target claude|codex|antigravity [name...]",
    positional: "[name...]  installed plugin names to unlink (default: all)",
    blurb: "Disable the plugins in one agent without removing them from the store —\nthe per-agent inverse of `link`. To delete from the store and every agent\nat once, use `adg plugins remove`.",
    flags: ["target", ...SCOPE],
    examples: [
      "adg plugins unlink --target antigravity asc   # drop asc from agy only",
      "adg plugins unlink --target codex             # unlink everything from codex",
    ],
  },
  sync: {
    summary: "reconcile a runtime's plugins with the store",
    synopsis: "adg plugins sync --target claude|codex|antigravity [name...]",
    positional: "[name...]  installed plugin names to sync (default: all)",
    blurb: "Make one agent's copy match the store: regenerate manifests and re-import,\nclearing components that were dropped since the last sync. Use this to repair\ndrift (e.g. residual skills). Only store-known plugins are touched.",
    flags: ["target", ...SCOPE],
    examples: [
      "adg plugins sync --target antigravity asc   # clear agy residual for asc",
      "adg plugins sync --target claude            # re-sync every plugin into Claude",
    ],
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

export const PLUGIN_ALIASES: Record<string, string> = { rm: "remove", mp: "marketplace" };

export function flagLabel(name: FlagName): string {
  const f = FLAGS[name]!;
  const lead = f.short ? `-${f.short}, --${name}` : `    --${name}`;
  return f.hint ? `${lead} ${f.hint}` : lead;
}

export function renderFlags(names: readonly FlagName[]): string {
  if (names.length === 0) return "";
  const labels = names.map(flagLabel);
  const width = Math.max(...labels.map((l) => l.length));
  const lines = names.map((n, i) => `  ${labels[i]!.padEnd(width)}  ${FLAGS[n]!.help}`);
  return `Flags:\n${lines.join("\n")}`;
}

export function renderPluginsHelp(): string {
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

export function renderVerbHelp(name: string): string {
  const cmd = PLUGIN_COMMANDS[name]!;
  const parts: string[] = [`adg plugins ${name} — ${cmd.summary}`, "", cmd.synopsis];
  if (cmd.positional) parts.push(`  ${cmd.positional}`);
  if (cmd.blurb) parts.push("", cmd.blurb);
  const flags = renderFlags(cmd.flags);
  if (flags) parts.push("", flags);
  if (cmd.examples) parts.push("", "Examples:", ...cmd.examples.map((e) => `  ${e}`));
  return parts.join("\n");
}

export function fail(msg: string, topUsage: string): never {
  console.error(`${ui.err("error:")} ${msg}\n`);
  console.error(topUsage);
  process.exit(1);
}

export function resolveScopeDir(values: Record<string, unknown>): string {
  if (typeof values.dir === "string") return resolve(values.dir);
  return values.global ? globalPluginsDir() : projectPluginsDir();
}

export function scopeInfo(values: Record<string, unknown>): ScopeInfo {
  const label = typeof values.dir === "string" ? resolve(values.dir) : values.global ? "global" : "project";
  return { label, globalDir: globalPluginsDir() };
}

export function scopeOf(values: Record<string, unknown>): AgentScope {
  return values.global ? "user" : "project";
}

export const TARGET_ALIASES: Record<string, AdapterTarget> = {
  anthropic: "claude",
  openai: "codex",
  agy: "antigravity",
  gemini: "antigravity",
};

export function resolveTargets(target: string | undefined | null, topUsage: string): AdapterTarget[] {
  if (!target || target === "all") return [...ADAPTER_TARGETS];
  const t = TARGET_ALIASES[target] ?? target;
  if ((ADAPTER_TARGETS as readonly string[]).includes(t)) return [t as AdapterTarget];
  fail(`invalid --target "${target}" (expected ${[...ADAPTER_TARGETS, "all"].join("|")})`, topUsage);
}

export function requireSingleTarget(target: string | undefined, verb: string, topUsage: string): AdapterTarget {
  if (target === undefined || target === "all") {
    fail(`plugins ${verb} requires a single --target (${ADAPTER_TARGETS.join("|")})`, topUsage);
  }
  return resolveTargets(target, topUsage)[0]!;
}

export function resolveComponents(only: string | undefined, topUsage: string): ComponentType[] | undefined {
  if (only === undefined) return undefined;
  const parts = only.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !(COMPONENT_TYPES as readonly string[]).includes(p));
  if (bad.length > 0) fail(`invalid --only "${bad.join(", ")}" (expected ${COMPONENT_TYPES.join("|")})`, topUsage);
  return parts as ComponentType[];
}

export function parseVerb(name: string, flags: readonly FlagName[], rest: string[]): { values: ParsedValues; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: rest, options: optionsFor(flags), allowPositionals: true });
    return { values: values as ParsedValues, positionals };
  } catch (err) {
    console.error(`${ui.err("error:")} ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(renderVerbHelp(name));
    process.exit(1);
  }
}

export function wantsHelp(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}
