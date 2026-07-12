import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { findManifestFile, readManifest } from "../manifest.ts";
import { resolveDefaultDsl } from "../default-dsl.ts";
import type { AdgManifest } from "../types.ts";
import { pluginContents } from "../components.ts";
import { cloneGitHub, parseSource, type GitRunner } from "../sources.ts";

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
export async function inspectSource(opts: { spec: string; ref?: string; gitRunner?: GitRunner }): Promise<PluginInspection> {
  const parsed = parseSource(opts.spec);
  if (parsed.kind === "local") {
    return inspectPlugin(parsed.dir);
  }
  if (parsed.path) throw new Error("GitHub subdirectory sources are not supported; define a marketplace and select with --plugin or --all");

  const staging = mkdtempSync(join(tmpdir(), "adg-inspect-"));
  try {
    cloneGitHub({ ...parsed, ref: opts.ref ?? parsed.ref }, staging, { runner: opts.gitRunner });
    const result = inspectPlugin(staging, { name: parsed.repo, description: parsed.repo });
    return { ...result, root: "." };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
