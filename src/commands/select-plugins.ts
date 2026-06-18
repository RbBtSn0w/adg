import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PluginChoice } from "./install.ts";

/**
 * Interactive multiselect for choosing which plugins to install from a source
 * that holds several. Mirrors the skills install flow. Native (reverse-adapted)
 * plugins are flagged so the user knows they came from a Claude/Codex manifest.
 */
export async function selectPluginsInteractive(choices: PluginChoice[]): Promise<string[]> {
  const selected = await p.multiselect({
    message: `Select plugins to install ${pc.dim("(space to toggle)")}`,
    options: choices.map((c) => ({
      value: c.name,
      label: c.native ? `${c.name} ${pc.dim("(native)")}` : c.name,
      ...(c.description
        ? { hint: c.description.length > 60 ? c.description.slice(0, 57) + "..." : c.description }
        : {}),
    })),
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel("Installation cancelled");
    process.exit(0);
  }
  return selected as string[];
}
