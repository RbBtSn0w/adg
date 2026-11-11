import * as p from "@clack/prompts";
import pc from "picocolors";
import { UpdateCancelled } from "./source-upgrade.ts";
import type { PluginChoice } from "./install.ts";

export const FOLLOW_ALL_PLUGINS = ":follow-all";

/**
 * Interactive multiselect for choosing which plugins to install from a source
 * that holds several. Mirrors the skills install flow. Native (reverse-adapted)
 * plugins are flagged so the user knows they came from a Claude/Codex manifest.
 */
export async function selectPluginsInteractive(choices: PluginChoice[]): Promise<string[]> {
  const subscription = await p.select({
    message: "Choose how this source is followed",
    options: [
      { value: "selected", label: "Choose plugins", hint: "update selected plugins; do not automatically add future plugins" },
      { value: "all", label: "Follow all plugins", hint: "install every current plugin and subscribe to future additions" },
    ],
    initialValue: "selected",
  });
  if (p.isCancel(subscription)) throw new UpdateCancelled("Installation cancelled");
  if (subscription === "all") return [FOLLOW_ALL_PLUGINS];
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
    throw new UpdateCancelled("Installation cancelled");
  }
  return selected as string[];
}
