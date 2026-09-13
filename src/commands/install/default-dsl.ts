import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { copyPluginDir, writeJson } from "../../fsutil.ts";
import { ADG_MANIFEST_PATH } from "../../manifest.ts";
import { githubRepositoryDescription, scanPlugins, type ParsedSource } from "../../sources.ts";
import { resolveDefaultDsl } from "../../default-dsl.ts";
import type { PluginCandidate } from "../../deps.ts";
import type { DefaultDefinitionProfile } from "../../types.ts";
import type { AddOptions } from "./types.ts";

export interface DefaultDslPlugin {
  candidates: Map<string, PluginCandidate>;
  converted: string[];
  structuralName: string;
  /** The real source dir, so `buildOrigin` points at it instead of the staging copy. */
  originDirOverride: string;
  definition: DefaultDefinitionProfile;
  cleanup: () => void;
}

/**
 * Synthesize a single Default DSL plugin from a source that holds no explicit
 * ADG/native manifest: generate a manifest for the whole tree, stage a copy
 * with it written in, and scan that staging copy as the sole candidate.
 */
export async function synthesizeDefaultDslPlugin(
  opts: AddOptions,
  parsed: ParsedSource,
  workRoot: string,
  resolvedRevision: string | undefined,
): Promise<DefaultDslPlugin> {
  const defaultDescription =
    parsed.kind === "github" && !opts.preparedSourceDir && !opts.defaultDescription
      ? await githubRepositoryDescription(parsed.source)
      : undefined;
  const structuralIdentity = opts.as ?? opts.structuralIdentity ?? (parsed.kind === "github" ? parsed.source : basename(workRoot));
  const generated = resolveDefaultDsl(workRoot, {
    name: structuralIdentity,
    description: defaultDescription ?? opts.defaultDescription ?? structuralIdentity,
  }, {
    ...(parsed.kind === "github" && resolvedRevision ? { resolvedRevision } : {}),
  });
  const authorized = opts.authorizedComponents;
  const unauthorizedRisk = generated.components.some((c) => (c === "hooks" || c === "mcp") && !authorized?.includes(c));
  if (opts.nonInteractive && unauthorizedRisk && opts.only === undefined) {
    throw new Error("default source exposes hooks or MCP; pass --only to explicitly authorize selected components");
  }
  const staging = mkdtempSync(join(tmpdir(), "adg-default-plugin-"));
  let candidates: Map<string, PluginCandidate>;
  try {
    copyPluginDir(workRoot, staging);
    writeJson(join(staging, ADG_MANIFEST_PATH), generated.manifest);
    candidates = scanPlugins(staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    candidates,
    converted: [],
    structuralName: generated.manifest.name,
    originDirOverride: workRoot,
    definition: {
      kind: "default-dsl/v1",
      root: ".",
      ...(opts.as ? { as: generated.manifest.name } : {}),
      description: generated.manifest.description,
      fingerprint: generated.fingerprint,
      authorizedComponents: authorized ?? (opts.only ?? generated.components),
    },
    cleanup: () => rmSync(staging, { recursive: true, force: true }),
  };
}
