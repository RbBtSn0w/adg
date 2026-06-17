import { ADG_SCHEMA_VERSION, type AdgManifest } from "../types.ts";
import { validateManifest } from "../manifest.ts";

export type NativeKind = "anthropic" | "openai";

/**
 * Reverse-adapt a runtime-native manifest (.claude-plugin/plugin.json or
 * .codex-plugin/plugin.json) into a canonical ADG manifest. This is the inverse
 * of the forward adapters and is used when importing existing plugins.
 *
 * Missing `version` falls back to 0.0.0 (callers may override with a git SHA);
 * skills normalize to the manifest's array/string or the default ./skills/.
 */
export function fromNativeManifest(raw: unknown, _kind: NativeKind): AdgManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("native manifest must be a JSON object");
  }
  const n = raw as Record<string, unknown>;
  if (typeof n.name !== "string") throw new Error("native manifest missing string `name`");

  const manifest: AdgManifest = {
    schemaVersion: ADG_SCHEMA_VERSION,
    name: n.name,
    version: typeof n.version === "string" ? n.version : "0.0.0",
    description: typeof n.description === "string" && n.description ? n.description : `${n.name} plugin.`,
  };

  const out = manifest as unknown as Record<string, unknown>;
  copyIfString(n, out, "license");
  copyIfString(n, out, "category");
  copyIfString(n, out, "homepage");
  copyIfString(n, out, "commands");
  copyIfString(n, out, "agents");
  copyIfString(n, out, "hooks");
  copyIfString(n, out, "mcp");

  if (typeof n.author === "object" && n.author !== null) {
    manifest.author = n.author as AdgManifest["author"];
  } else if (typeof n.author === "string") {
    manifest.author = { name: n.author };
  }

  if (typeof n.skills === "string" || isStringArray(n.skills)) {
    manifest.skills = n.skills as string | string[];
  } else {
    manifest.skills = "./skills/";
  }

  manifest.strict = typeof n.strict === "boolean" ? n.strict : true;

  return validateManifest(manifest);
}

function copyIfString(src: Record<string, unknown>, dst: Record<string, unknown>, key: string): void {
  if (typeof src[key] === "string") dst[key] = src[key];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
