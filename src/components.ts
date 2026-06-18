import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveSkills } from "./skills.ts";
import { COMPONENT_TYPES, type AdgManifest, type ComponentType, type PluginSelection } from "./types.ts";

export { COMPONENT_TYPES };

/** Member names per component type a plugin declares (empty when absent). */
export type PluginContents = Record<ComponentType, string[]>;

/** Recursively collect regular (non-dotfile) file basenames, without extension. */
function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) out.push(...collectFiles(join(dir, e.name)));
    else out.push(e.name.replace(/\.[^.]+$/, ""));
  }
  return out.sort();
}

/**
 * A single file's member name: its basename without extension. `base` is
 * injectable so the OS-separator handling can be exercised deterministically in
 * tests (path.win32.basename vs path.posix.basename) regardless of host platform.
 */
export function fileMemberName(absPath: string, base: typeof basename = basename): string {
  return base(absPath).replace(/\.[^.]+$/, "");
}

/** Members of a declared path: a directory yields its files, a file yields its own name. */
function membersOf(dir: string, rel: string | undefined): string[] {
  if (!rel) return [];
  const abs = join(dir, rel);
  if (!existsSync(abs)) return [];
  const files = collectFiles(abs);
  if (files.length > 0) return files;
  return [fileMemberName(abs)]; // a single file
}

/** Server names declared in an MCP config file (mcpServers/servers map). */
function mcpServers(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const servers = (json.mcpServers ?? json.servers) as Record<string, unknown> | undefined;
    return servers && typeof servers === "object" ? Object.keys(servers).sort() : [];
  } catch {
    return [];
  }
}

/** Enumerate what a plugin contains, by reading its manifest's component paths. */
export function pluginContents(dir: string, manifest: AdgManifest): PluginContents {
  return {
    skills: resolveSkills(dir, manifest),
    agents: membersOf(dir, manifest.agents),
    commands: membersOf(dir, manifest.commands),
    apps: membersOf(dir, manifest.apps),
    hooks: membersOf(dir, manifest.hooks),
    mcp: manifest.mcp ? mcpServers(join(dir, manifest.mcp)) : [],
  };
}

/** Component types this plugin actually has (non-empty). */
export function presentComponents(contents: PluginContents): ComponentType[] {
  return COMPONENT_TYPES.filter((c) => contents[c].length > 0);
}

/** Whether a category is exposed under a selection (no selection = everything). */
export function isExposed(selection: PluginSelection | undefined, category: ComponentType): boolean {
  return !selection || selection.components.includes(category);
}

/** Apply a selection to a contents map, returning only the exposed members. */
export function exposedContents(contents: PluginContents, selection: PluginSelection | undefined): PluginContents {
  if (!selection) return contents;
  const out = {} as PluginContents;
  for (const c of COMPONENT_TYPES) {
    if (!isExposed(selection, c)) {
      out[c] = [];
    } else if (c === "skills" && selection.skills) {
      out[c] = contents.skills.filter((s) => selection.skills!.includes(s));
    } else {
      out[c] = contents[c];
    }
  }
  return out;
}
