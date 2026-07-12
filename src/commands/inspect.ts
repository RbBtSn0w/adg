import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
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
export function inspectPlugin(root: string): PluginInspection {
  const dir = resolve(root);
  const file = findManifestFile(dir);
  const manifest = file
    ? readManifest(dir)
    : resolveDefaultDsl(dir, { name: basename(dir), description: basename(dir) }).manifest;
  const contents = pluginContents(dir, manifest);
  return { kind: file ? "manifest" : "default-dsl", root: dir, manifest, components: Object.entries(contents).filter(([, v]) => v.length > 0).map(([k]) => k) };
}

/** Resolve a local or GitHub source without creating a store, lock, or projection. */
export async function inspectSource(opts: { spec: string; path?: string; ref?: string; gitRunner?: GitRunner }): Promise<PluginInspection> {
  const parsed = parseSource(opts.spec);
  if (parsed.kind === "local") {
    const root = resolve(parsed.dir, opts.path ?? ".");
    assertSourcePath(parsed.dir, root);
    return inspectPlugin(root);
  }

  const staging = mkdtempSync(`${tmpdir()}/adg-inspect-`);
  try {
    cloneGitHub({ ...parsed, ref: opts.ref ?? parsed.ref }, staging, { runner: opts.gitRunner });
    const root = resolve(staging, opts.path ?? parsed.path ?? ".");
    assertSourcePath(staging, root);
    const result = inspectPlugin(root);
    return { ...result, root: opts.path ?? parsed.path ?? "." };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertSourcePath(sourceRoot: string, candidate: string): void {
  const rel = relative(resolve(sourceRoot), resolve(candidate));
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[A-Za-z]:[\\/]/.test(rel)) {
    throw new Error("path must stay within the source root");
  }
}
