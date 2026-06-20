import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Normalize a path to forward slashes (stable across Windows and POSIX hosts). */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function writeText(file: string, value: string): void {
  ensureDir(dirname(file));
  writeFileSync(file, value);
}

/**
 * Copy a plugin directory, skipping VCS and dependency noise. When `include` is
 * given (a root-relative path predicate, e.g. from `packageFilter`), only the
 * declared payload is copied — dev cruft like `src/`/`test/` is left behind.
 */
export function copyPluginDir(
  src: string,
  dest: string,
  include?: (relPath: string) => boolean,
): void {
  ensureDir(dirname(dest));
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const base = from.split(/[/\\]/).pop() ?? "";
      if (base === ".git" || base === "node_modules" || base === ".DS_Store") return false;
      if (!include) return true;
      return include(relative(src, from));
    },
  });
}
