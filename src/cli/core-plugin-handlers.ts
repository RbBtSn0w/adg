import { resolve } from "node:path";
import { adaptPlugin } from "../commands/adapt.ts";
import { initScaffold, type InitType } from "../commands/init.ts";
import { inspectSource } from "../commands/inspect.ts";
import { listPlugins } from "../commands/list.ts";
import { pluginStatus } from "../commands/status.ts";
import { validatePlugin } from "../commands/validate.ts";
import { ui } from "../render/ui.ts";
import { pluginsListJson, pluginsStatusJson, printJson } from "../render/json.ts";
import { renderPluginList, renderStatus } from "../render/plugins.ts";
import {
  fail,
  parseVerb,
  resolveScopeDir,
  resolveTargets,
  scopeOf,
  type PluginCommand,
} from "./index.ts";

type CorePluginVerb = "init" | "adapt" | "validate" | "inspect" | "list" | "status";

const CORE_PLUGIN_VERBS = new Set<string>(["init", "adapt", "validate", "inspect", "list", "status"]);

export async function handleCorePluginVerb(
  verb: string,
  rest: string[],
  cmd: PluginCommand,
): Promise<boolean> {
  if (!CORE_PLUGIN_VERBS.has(verb)) return false;

  switch (verb as CorePluginVerb) {
    case "init": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const name = positionals[0];
      if (!name) fail("plugins init requires a <name>");
      const dir = values.dir ? resolve(values.dir) : resolve(process.cwd(), "plugins");
      const type = (values.type ?? "plugin") as InitType;
      if (type !== "plugin" && type !== "marketplace" && type !== "all") {
        fail(`invalid --type "${values.type}" (expected plugin|marketplace|all)`);
      }
      const res = initScaffold({
        name,
        dir,
        type,
        description: values.description,
        author: values.author,
        skill: values.skill?.[0],
      });
      console.log(`${ui.ok(`created ${type}`)} at ${ui.name(res.pluginDir)}`);
      for (const file of res.created) console.log(ui.meta(`  + ${file}`));
      return true;
    }
    case "adapt": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      for (const result of adaptPlugin(pluginDir, resolveTargets(values.target))) {
        console.log(`${ui.ok("adapted")} ${ui.name(result.target)} ${ui.meta(`-> ${result.file}`)}`);
      }
      return true;
    }
    case "validate": {
      const { positionals } = parseVerb(verb, cmd.flags, rest);
      const pluginDir = resolve(positionals[0] ?? process.cwd());
      const result = validatePlugin(pluginDir);
      if (result.ok) {
        console.log(`${ui.ok("ok:")} ${ui.name(pluginDir)} is a valid ADG plugin`);
      } else {
        console.error(`${ui.err("invalid:")} ${ui.name(pluginDir)}`);
        for (const issue of result.issues) console.error(ui.warn(`  - ${issue}`));
        process.exit(1);
      }
      return true;
    }
    case "inspect": {
      const { values, positionals } = parseVerb(verb, cmd.flags, rest);
      const result = await inspectSource({ spec: positionals[0] ?? process.cwd(), ref: values.ref });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${ui.ok("inspected")} ${ui.name(result.manifest.name)} ${ui.meta(`[${result.kind}] ${result.components.join(", ") || "no components"}`)}`);
      return true;
    }
    case "list": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const pluginsDir = resolveScopeDir(values);
      const plugins = listPlugins(pluginsDir);
      if (values.json) printJson(pluginsListJson(plugins, pluginsDir));
      else for (const line of renderPluginList(plugins, pluginsDir, { verbose: values.verbose })) console.log(line);
      return true;
    }
    case "status": {
      const { values } = parseVerb(verb, cmd.flags, rest);
      const targets = resolveTargets(values.target);
      const pluginsDir = resolveScopeDir(values);
      const scope = scopeOf(values);
      const statuses = pluginStatus({ pluginsDir, scope, targets });
      if (values.json) printJson(pluginsStatusJson(statuses, pluginsDir, scope, targets));
      else for (const line of renderStatus(statuses)) console.log(line);
      return true;
    }
  }
}
