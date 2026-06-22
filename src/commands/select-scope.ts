import * as p from "@clack/prompts";

/**
 * Ask whether to install into the project (.agents/plugins) or globally
 * (~/.agents/plugins). Returns true for global. Used by `add` when no scope
 * flag (--global/--project/--dir) was given in an interactive terminal.
 */
export async function selectScopeInteractive(): Promise<boolean> {
  const scope = await p.select({
    message: "Installation scope",
    options: [
      { value: false, label: "Project", hint: ".agents/plugins (committed with your project)" },
      { value: true, label: "Global", hint: "~/.agents/plugins (available across all projects)" },
    ],
  });
  if (p.isCancel(scope)) {
    p.cancel("Installation cancelled");
    process.exit(0);
  }
  return scope as boolean;
}

export type UpdateScope = "project" | "global" | "both";

/**
 * Ask which scope(s) to update: project, global, or both — mirroring
 * `adg skills update`. Used by `plugins update` when no scope flag was given in
 * an interactive terminal.
 */
export async function selectUpdateScopeInteractive(): Promise<UpdateScope> {
  const scope = await p.select({
    message: "Update scope",
    options: [
      { value: "project" as UpdateScope, label: "Project", hint: "plugins in .agents/plugins" },
      { value: "global" as UpdateScope, label: "Global", hint: "plugins in ~/.agents/plugins" },
      { value: "both" as UpdateScope, label: "Both", hint: "update everything" },
    ],
  });
  if (p.isCancel(scope)) {
    p.cancel("Cancelled");
    process.exit(0);
  }
  return scope as UpdateScope;
}
