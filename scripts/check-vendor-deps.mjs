#!/usr/bin/env node
/**
 * Guard against root <-> vendored dependency drift (tech-debt TD-3).
 *
 * The vendored skills CLI (vendor/skills) ships its own upstream package.json,
 * but its runtime third-party deps are resolved from the ROOT node_modules —
 * root is the single source of truth. Each root range must therefore be at
 * least the floor the vendored source was authored against (declared in
 * vendor/skills/package.json, dependencies + devDependencies combined).
 *
 * This script discovers the bare specifiers the vendored `src/` actually
 * imports, then fails if any of them is missing from root deps or pinned below
 * the vendored floor. Zero dependencies so it can run in any CI step.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "vendor", "skills");

const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const vendorPkg = JSON.parse(readFileSync(path.join(vendorDir, "package.json"), "utf8"));

const rootDeps = { ...rootPkg.dependencies };
const vendorDeps = { ...vendorPkg.devDependencies, ...vendorPkg.dependencies };

/** Bare (non-relative, non-builtin) specifiers imported by the vendored source. */
function vendoredImports() {
  const srcDir = path.join(vendorDir, "src");
  const specifiers = new Set();
  const importRe = /\bfrom\s+["']([^"']+)["']/g;
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(path.join(srcDir, file), "utf8");
    for (const m of text.matchAll(importRe)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      // Map subpath imports (e.g. "fs/promises") to their package name.
      const pkg = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      specifiers.add(pkg);
    }
  }
  return specifiers;
}

/** Parse the minimum version a caret/tilde/plain range allows -> [major, minor, patch]. */
function floor(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when root floor >= vendor floor (semver tuple compare). */
function satisfies(rootFloor, vendorFloor) {
  for (let i = 0; i < 3; i++) {
    if (rootFloor[i] > vendorFloor[i]) return true;
    if (rootFloor[i] < vendorFloor[i]) return false;
  }
  return true;
}

// Node builtins that may appear without the node: prefix.
const BUILTINS = new Set([
  "child_process", "crypto", "fs", "os", "path", "readline", "url", "util",
]);

const problems = [];
for (const pkg of [...vendoredImports()].sort()) {
  if (BUILTINS.has(pkg)) continue;
  const vendorRange = vendorDeps[pkg];
  if (!vendorRange) continue; // upstream did not declare it; nothing to compare against
  const rootRange = rootDeps[pkg];
  if (!rootRange) {
    problems.push(`${pkg}: imported by vendored src but MISSING from root dependencies (vendor declares ${vendorRange})`);
    continue;
  }
  const rf = floor(rootRange);
  const vf = floor(vendorRange);
  if (!rf || !vf) {
    problems.push(`${pkg}: unparseable range (root ${rootRange}, vendor ${vendorRange})`);
    continue;
  }
  if (!satisfies(rf, vf)) {
    problems.push(`${pkg}: root ${rootRange} is BELOW vendored floor ${vendorRange} — bump root to >= ${vf.join(".")}`);
  }
}

if (problems.length) {
  console.error("Vendored dependency drift detected:\n  - " + problems.join("\n  - "));
  console.error("\nRoot is the single source of truth; raise the root range(s) above to clear this.");
  process.exit(1);
}

console.log("vendor-deps: root dependencies satisfy all vendored floors. OK");
