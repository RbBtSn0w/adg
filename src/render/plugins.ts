import { ui, formatColumns, abbrevHome, ellipsizeStart } from "./ui.ts";
import { installedPluginDir } from "../paths.ts";
import { agentsForComponents, getAgent, type AgentSyncResult } from "../agents/index.ts";
import type { ComponentType } from "../types.ts";
import type { ListedPlugin } from "../commands/list.ts";
import type { MarketplaceGroup } from "../commands/marketplace.ts";

// ---------------------------------------------------------------------------
// Presentation layer for `adg plugins`. Each function turns command-layer data
// into terminal-ready lines (returned as string[]), so bin/adg.ts only parses
// args, calls a command, prints the lines — and the formatting is unit-testable
// without spawning the CLI. Color mirrors `adg skills list` throughout.
// ---------------------------------------------------------------------------

/** A plugin's components, each expanded to its member names (verbose view). */
export function renderContents(
  contents: Record<string, string[]> | undefined,
  headerIndent: number,
): string[] {
  const out: string[] = [];
  const entries = (Object.entries(contents ?? {}) as [string, string[]][]).filter(
    ([, names]) => names.length > 0,
  );
  for (const [type, names] of entries) {
    const maxColWidth = Math.max(1, ...names.map((n) => n.length));
    out.push(`${" ".repeat(headerIndent)}${ui.name(type)} ${ui.meta(`(${names.length}):`)}`);
    out.push(formatColumns(names, { indent: headerIndent + 2, maxColWidth }));
  }
  return out;
}

/** Per-agent sync outcomes (enabled/disabled/re-synced), printed generically. */
export function renderAgentReport(agents: AgentSyncResult[] | undefined, verb: string): string[] {
  const out: string[] = [];
  for (const r of agents ?? []) {
    const name = getAgent(r.agent)?.displayName ?? r.agent;
    if (r.affected.length > 0) out.push(`${ui.ok(verb)} in ${ui.name(name)}: ${r.affected.join(", ")}`);
    else if (r.skipped)
      out.push(
        ui.warn(
          `note: \`${r.agent}\` CLI not found — run \`adg plugins link --target ${r.agent}\` after installing it.`,
        ),
      );
  }
  return out;
}

const PATH_MAX = 44;

/** `adg plugins list` — aligned name/path/agents rows, with optional verbose contents. */
export function renderPluginList(
  plugins: ListedPlugin[],
  pluginsDir: string,
  opts: { verbose?: boolean } = {},
): string[] {
  if (plugins.length === 0) return [ui.meta(`no plugins recorded in ${pluginsDir}`)];

  // Pre-compute each plugin's display row so the name/path columns can be
  // aligned across rows (à la `adg skills list`). The `Agents:` column is
  // derived from the exposed component types — which agents can adapt it.
  const rows = plugins.map((p) => {
    const exposed = (Object.entries(p.contents ?? {}) as [string, string[]][]).filter(
      ([, names]) => names.length > 0,
    );
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

  // Color mirrors `adg skills list`: cyan name, dim path / dim "Agents:" label
  // with the agent names left bright, and the provenance/counts line fully
  // dimmed as secondary metadata. Widths are measured on the uncolored strings
  // (above), so wrapping the padded text keeps columns aligned.
  const out: string[] = [];
  for (const r of rows) {
    const partial = r.p.selection ? "  (partial)" : "";
    const name = ui.name(r.label.padEnd(nameW));
    const path = ui.meta(ellipsizeStart(r.path, pathW).padEnd(pathW));
    out.push(`${name}  ${path}  ${ui.meta("Agents:")} ${r.agents}`);
    const provenance = `[${r.p.origin.type}] ${r.p.folderHash.slice(0, 19)}${partial}`;
    out.push(ui.meta(`  ${[provenance, ...r.counts].join("   ")}`));
    if (opts.verbose) out.push(...renderContents(r.p.contents, 4));
  }
  return out;
}

/**
 * `adg plugins marketplace list` — installed plugins grouped by source.
 * `details` (name → ListedPlugin) enables the verbose per-plugin component drill;
 * pass it only when --verbose is set.
 */
export function renderMarketplaceList(
  groups: MarketplaceGroup[],
  details?: Map<string, ListedPlugin>,
): string[] {
  if (groups.length === 0) return [ui.meta("No plugins installed.")];

  const out: string[] = [];
  for (const g of groups) {
    const ref = g.ref ? `@${g.ref}` : "";
    const n = g.installed.length;
    const tag = g.remote ? "" : ui.warn("  (local — re-run add to update)");
    out.push(`${ui.name(`${g.source}${ref}`)}  ${ui.meta(`(${n} plugin${n !== 1 ? "s" : ""})`)}${tag}`);
    if (details) {
      for (const name of g.installed) {
        const p = details.get(name);
        out.push(`  ${ui.name(name)}${p?.selection ? ui.meta("  (partial)") : ""}`);
        out.push(...renderContents(p?.contents, 4));
      }
    } else {
      out.push(formatColumns(g.installed));
    }
  }
  return out;
}
