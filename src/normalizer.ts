import { join } from "node:path";
import { adaptNativePlugins } from "./adapters/reverse.ts";
import { resolveDefaultDsl } from "./default-dsl.ts";
import { writeJson } from "./fsutil.ts";
import { ADG_MANIFEST_PATH, findManifestFile } from "./manifest.ts";
import { scanPlugins } from "./sources.ts";
import type { PluginCandidate } from "./deps.ts";
import type { DefaultDefinitionProfile } from "./types.ts";

export interface NormalizerOptions {
  /** Expected plugin name or alias (useful for Default DSL synthesis). */
  name?: string;
  /** Plugin definition profile recorded in lockfile. */
  definition?: DefaultDefinitionProfile;
  /** Commit SHA or immutable revision if known. */
  resolvedRevision?: string;
  /** Whether to record OTel telemetry events during normalization (default true). */
  recordTelemetry?: boolean;
}

export interface NormalizationResult {
  /** Whether an authoritative ADG manifest was already present. */
  alreadyAdg: boolean;
  /** Names of any native plugins that were adapted in-place. */
  adaptedPlugins: string[];
  /** Whether a Default DSL manifest was synthesized. */
  synthesizedDefaultDsl: boolean;
  /** Discovered plugin candidates after normalization. */
  candidates: Map<string, PluginCandidate>;
}

/**
 * Normalizes a source directory into canonical ADG plugins.
 *
 * If no authoritative ADG manifest is found, attempts to adapt native runtime
 * manifests (Claude/Codex). If still no manifest is found and the plugin matches
 * or is declared as Default DSL, synthesizes `.agents/.plugin.json`.
 *
 * This ensures discovery, installation, updates, and cache restoration all
 * share the exact same manifest synthesis and adaptation state machine.
 */
export function normalizePluginSource(
  sourceDir: string,
  options: NormalizerOptions = {},
): NormalizationResult {
  const existingManifest = findManifestFile(sourceDir);
  if (existingManifest) {
    return {
      alreadyAdg: true,
      adaptedPlugins: [],
      synthesizedDefaultDsl: false,
      candidates: scanPlugins(sourceDir),
    };
  }

  // 1. Try adapting native plugins (Claude / Codex)
  const adapted = adaptNativePlugins(sourceDir);
  if (findManifestFile(sourceDir) || adapted.length > 0) {
    return {
      alreadyAdg: false,
      adaptedPlugins: adapted,
      synthesizedDefaultDsl: false,
      candidates: scanPlugins(sourceDir),
    };
  }

  // 2. Synthesize Default DSL manifest only when the lock entry explicitly records
  // the plugin as having been installed via the Default DSL path.
  const shouldSynthesizeDefaultDsl = options.definition?.kind === "default-dsl/v1";

  if (shouldSynthesizeDefaultDsl && options.name) {
    try {
      const generated = resolveDefaultDsl(sourceDir, {
        name: options.definition?.as ?? options.name,
        description: options.definition?.description ?? options.name,
      }, {
        ...(options.resolvedRevision ? { resolvedRevision: options.resolvedRevision } : {}),
        recordTelemetry: options.recordTelemetry ?? true,
      });
      writeJson(join(sourceDir, ADG_MANIFEST_PATH), generated.manifest);
      return {
        alreadyAdg: false,
        adaptedPlugins: [],
        synthesizedDefaultDsl: true,
        candidates: scanPlugins(sourceDir),
      };
    } catch {
      // Not a valid Default DSL source; fall through to return un-synthesized candidates
    }
  }

  return {
    alreadyAdg: false,
    adaptedPlugins: [],
    synthesizedDefaultDsl: false,
    candidates: scanPlugins(sourceDir),
  };
}
