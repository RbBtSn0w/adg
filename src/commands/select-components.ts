import * as p from "@clack/prompts";
import pc from "picocolors";
import type { SelectComponentsRequest } from "./install.ts";
import type { ComponentType, PluginSelection } from "../types.ts";
import { multiselectSkills } from "./multiselect-skills.ts";

function cancelled<T>(value: T | symbol): value is symbol {
  if (p.isCancel(value)) {
    p.cancel("Installation cancelled");
    process.exit(0);
  }
  return false;
}

/**
 * The "install everything?" gate. Returns true to install each selected plugin
 * in full, false to drop into per-plugin component selection. Used by `add` in
 * an interactive terminal when no --only/--skill flags were given.
 */
export async function confirmFullInstall(plugins: string[]): Promise<boolean> {
  const list = plugins.length === 1 ? plugins[0] : `${plugins.length} plugins`;
  const choice = await p.select({
    message: `Install everything in ${pc.cyan(list)}?`,
    options: [
      { value: true, label: "Yes, install all", hint: "every skill, command, agent, mcp…" },
      { value: false, label: "No, let me choose", hint: "pick components per plugin" },
    ],
    initialValue: true,
  });
  if (cancelled(choice)) return true;
  return choice as boolean;
}

/**
 * Per-plugin component picker (①). Choose which categories to expose; if skills
 * is kept and the plugin has several, drill in to pick individual skills. Files
 * are still installed in full — this only narrows what the runtime sees.
 */
export async function selectComponentsInteractive(req: SelectComponentsRequest): Promise<PluginSelection> {
  const components = await p.multiselect({
    message: `${pc.bold(req.name)} — what to install? ${pc.dim("(space to toggle)")}`,
    options: req.present.map((c) => ({ value: c, label: `${c} (${req.contents[c].length})` })),
    initialValues: [...req.present],
    required: true,
  });
  if (cancelled(components)) return { components: [...req.present] };
  const chosen = components as ComponentType[];

  const selection: PluginSelection = { components: chosen };

  // Drill into individual skills only when skills is kept and there's a choice.
  if (chosen.includes("skills") && req.contents.skills.length > 1) {
    const message = `${pc.bold(req.name)} — which skills? ${pc.dim("(space to toggle)")}`;
    const options = req.contents.skills.map((s) => ({ value: s, label: s }));
    const initialValues = [...req.contents.skills];
    const skills = req.skillDescription
      ? await multiselectSkills({ message, options, initialValues, loadDescription: req.skillDescription })
      : await p.multiselect({ message, options, initialValues, required: true });
    if (!cancelled(skills)) {
      const picked = skills as string[];
      if (picked.length !== req.contents.skills.length) selection.skills = picked;
    }
  }

  return selection;
}
