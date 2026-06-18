import * as p from "@clack/prompts";
import pc from "picocolors";
import type { AdapterTarget } from "../adapters/index.ts";
import { allAgents, detectedAgents } from "../agents/index.ts";

/**
 * Interactively choose which AI agents to adapt an installed plugin for.
 *
 * Mirrors the skills install flow: detect the agents present on the machine,
 * pre-select them, and let the user toggle. When nothing is detected we fall
 * back to pre-selecting every target so a fresh setup still adapts for all.
 *
 * Callers should only reach this in an interactive TTY without an explicit
 * `--target`; non-interactive paths stay flag-driven.
 */
export async function selectTargetsInteractive(): Promise<AdapterTarget[]> {
  const agents = allAgents();
  const detectedSet = new Set(detectedAgents().map((a) => a.id));
  const initialValues = (detectedSet.size > 0 ? [...detectedSet] : agents.map((a) => a.id)) as AdapterTarget[];

  if (detectedSet.size > 0) {
    const names = agents.filter((a) => detectedSet.has(a.id)).map((a) => pc.cyan(a.displayName)).join(", ");
    p.log.info(`Detected: ${names}`);
  } else {
    p.log.info(pc.dim("No agents detected locally — pre-selecting all."));
  }

  const selected = await p.multiselect({
    message: `Which agents do you want to adapt for? ${pc.dim("(space to toggle)")}`,
    options: agents.map((a) => ({
      value: a.id as AdapterTarget,
      label: a.displayName,
      ...(detectedSet.has(a.id) ? { hint: "detected" } : {}),
    })),
    initialValues,
    required: true,
  });

  if (p.isCancel(selected)) {
    p.cancel("Installation cancelled");
    process.exit(0);
  }

  return selected as AdapterTarget[];
}
