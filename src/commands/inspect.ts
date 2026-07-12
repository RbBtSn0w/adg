import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findManifestFile, readManifest } from "../manifest.ts";
import { resolveDefaultDsl } from "../default-dsl.ts";
import type { AdgManifest } from "../types.ts";
import { pluginContents } from "../components.ts";
import { cloneGitHub, parseSource, type GitRunner } from "../sources.ts";
import { resolveSourcePath } from "../source-path.ts";

export interface PluginInspection {
  kind: "default-dsl" | "manifest";
  root: string;
  manifest: AdgManifest;
  components: string[];
}

/** Read-only definition resolution for a local plugin root. */
export function inspectPlugin(root: string, metadata?: { name: string; description: string }): PluginInspection {
  const dir = resolve(root);
  const file = findManifestFile(dir);
  const manifest = file
    ? readManifest(dir)
    : resolveDefaultDsl(dir, metadata ?? { name: basename(dir), description: basename(dir) }).manifest;
  const contents = pluginContents(dir, manifest);
  return { kind: file ? "manifest" : "default-dsl", root: dir, manifest, components: Object.entries(contents).filter(([, v]) => v.length > 0).map(([k]) => k) };
}

/** Resolve a local or GitHub source without creating a store, lock, or projection. */
export async function inspectSource(opts: { spec: string; path?: string; ref?: string; gitRunner?: GitRunner }): Promise<PluginInspection> {
  const parsed = parseSource(opts.spec);
  if (parsed.kind === "local") {
    const root = resolveSourcePath(parsed.dir, opts.path ?? ".");
    return inspectPlugin(root);
  }

  const staging = mkdtempSync(join(tmpdir(), "adg-inspect-"));
  try {
    cloneGitHub({ ...parsed, ref: opts.ref ?? parsed.ref }, staging, { runner: opts.gitRunner });
    const selectedPath = opts.path ?? parsed.path;
    const root = resolveSourcePath(staging, selectedPath ?? ".");
    const identity = selectedPath ? basename(root) : parsed.repo;
    const result = inspectPlugin(root, { name: identity, description: identity });
    return { ...result, root: opts.path ?? parsed.path ?? "." };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
