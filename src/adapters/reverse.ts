import { ADG_SCHEMA_VERSION, type AdgManifest } from "../types.ts";
import { validateManifest } from "../manifest.ts";
import { toPosix } from "../fsutil.ts";

export type NativeKind = "claude" | "codex";

/**
 * Reverse-adapt a runtime-native manifest (.claude-plugin/plugin.json or
 * .codex-plugin/plugin.json) into a canonical ADG manifest. This is the inverse
 * of the forward adapters and is used when importing existing plugins.
 *
 * Missing `version` falls back to 0.0.0 (callers may override with a git SHA);
 * skills normalize to the manifest's array/string or the default ./skills/.
 *
 * `kind` disambiguates the two native skills-array conventions: Claude arrays are
 * already `./skills/<id>` paths, while Codex arrays are bare ids. Both canonicalize
 * to ADG's path-array contract so a later cross-adapt (e.g. codex → ADG → claude)
 * emits valid `./skills/<id>` entries instead of leaking bare ids into a Claude
 * manifest.
 */
export function fromNativeManifest(raw: unknown, kind: NativeKind): AdgManifest {
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
  if (typeof n.mcpServers === "string") out.mcpServers = n.mcpServers;
  copyIfString(n, out, "apps");

  if (typeof n.author === "object" && n.author !== null) {
    manifest.author = n.author as AdgManifest["author"];
  } else if (typeof n.author === "string") {
    manifest.author = { name: n.author };
  }

  if (typeof n.skills === "string") {
    manifest.skills = n.skills;
  } else if (isStringArray(n.skills)) {
    // Codex arrays are bare ids; map them to ADG's `./skills/<id>` path form.
    // Claude arrays are already paths, but a Windows-authored manifest may use
    // backslashes, so normalize separators to keep ADG manifests POSIX-pathed
    // (downstream `resolveSkillEntries` splits on `/`).
    manifest.skills = kind === "codex" ? n.skills.map(toSkillPath) : n.skills.map(toPosix);
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

/**
 * Canonicalize a skill reference (bare id or path) to ADG's `./skills/<id>` form.
 * Accepts both `/` and `\` separators so a Windows-authored native manifest
 * (e.g. `skills\\foo`) still yields a valid `./skills/foo` entry.
 */
function toSkillPath(ref: string): string {
  const name = ref.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ref;
  return `./skills/${name}`;
}
