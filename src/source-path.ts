import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Resolve a source-relative path and reject traversal or Windows drive prefixes. */
export function resolveSourcePath(sourceRoot: string, path: string): string {
  if (isAbsolute(path) || /^[/\\]{2}/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error("path must stay within the source root");
  }
  const root = resolve(sourceRoot);
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || /^[A-Za-z]:/.test(rel)) {
    throw new Error("path must stay within the source root");
  }
  // Lexical containment is insufficient when a checked-out source contains a
  // symlink. Resolve existing paths to ensure inspection never escapes it.
  if (existsSync(candidate)) {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const realRel = relative(realRoot, realCandidate);
    if (isAbsolute(realRel) || realRel === ".." || realRel.startsWith("../") || realRel.startsWith("..\\") || /^[A-Za-z]:/.test(realRel)) {
      throw new Error("path must stay within the source root");
    }
  }
  return candidate;
}
