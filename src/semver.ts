/**
 * Minimal semver comparison and range satisfaction.
 *
 * Supports the range forms ADG manifests use: exact (`1.2.3`), caret (`^1.2.3`),
 * tilde (`~1.2.3`), wildcard (`*` / `x`), and simple comparators
 * (`>=`, `>`, `<=`, `<`, `=`). Pre-release and build metadata are ignored for
 * comparison.
 */
export type Semver = [number, number, number];

export function parseVersion(v: string): Semver {
  const core = v.trim().replace(/^[v=]/, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".");
  // Accept partial ranges (`1`, `1.2`) by defaulting missing minor/patch to 0,
  // matching how semver ranges are commonly written in manifests.
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`invalid semantic version: "${v}"`);
  }
  return [
    Number(parts[0]),
    parts[1] !== undefined ? Number(parts[1]) : 0,
    parts[2] !== undefined ? Number(parts[2]) : 0,
  ];
}

export function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * Extract the dot-separated pre-release identifiers from a version string.
 *
 * Returns the segment after the first `-` (and before any `+` build metadata),
 * with numeric-only identifiers coerced to `number`. A stable version (no
 * pre-release) yields `[]`.
 */
export function parsePrerelease(v: string): Array<string | number> {
  const dashIndex = v.indexOf("-");
  if (dashIndex === -1) return [];
  // Drop build metadata, then split into identifiers.
  const pre = v.slice(dashIndex + 1).split("+")[0] ?? "";
  if (pre === "") return [];
  return pre.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
}

/**
 * Compare two pre-release identifier lists per SemVer §11.
 *
 * A stable version (empty list) outranks any pre-release. Otherwise identifiers
 * are compared left to right: numeric identifiers rank below alphanumeric ones,
 * numerics compare numerically, strings compare by ASCII, and when every shared
 * field is equal the longer list wins.
 */
export function comparePrerelease(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>,
): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // stable > pre-release
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1; // numeric < alphanumeric
    return (x as string) < (y as string) ? -1 : 1;
  }
  // All shared fields equal: the list with more fields has higher precedence.
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Full version comparison including pre-release precedence.
 *
 * Unlike {@link compare}, this honors the pre-release suffix so that, e.g.,
 * `0.3.0-beta.2 < 0.3.0-beta.3 < 0.3.0`. Used by the update check; range
 * matching ({@link satisfies}) deliberately ignores pre-release.
 */
export function compareVersions(a: string, b: string): number {
  const core = compare(parseVersion(a), parseVersion(b));
  if (core !== 0) return core;
  return comparePrerelease(parsePrerelease(a), parsePrerelease(b));
}

/**
 * Return the pre-release channel of a version — its first non-numeric
 * pre-release identifier (e.g. `0.3.0-beta.2` -> `"beta"`), or `null` for a
 * stable version. Used to pick the matching npm dist-tag.
 */
export function prereleaseChannel(v: string): string | null {
  for (const id of parsePrerelease(v)) {
    if (typeof id === "string") return id;
  }
  return null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const r = range.trim();

  if (r === "" || r === "*" || r === "x" || r === "X") return true;

  const cmp = r.match(/^(>=|<=|>|<|=)\s*(.+)$/);
  if (cmp) {
    const target = parseVersion(cmp[2]!);
    const c = compare(v, target);
    switch (cmp[1]) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      case "=": return c === 0;
    }
  }

  if (r.startsWith("^")) {
    const base = parseVersion(r.slice(1));
    if (compare(v, base) < 0) return false;
    const upper = caretUpperBound(base);
    return compare(v, upper) < 0;
  }

  if (r.startsWith("~")) {
    const base = parseVersion(r.slice(1));
    if (compare(v, base) < 0) return false;
    return compare(v, [base[0], base[1] + 1, 0]) < 0;
  }

  return compare(v, parseVersion(r)) === 0;
}

/** npm caret semantics: first non-zero leftmost component is the boundary. */
function caretUpperBound([major, minor, patch]: Semver): Semver {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}
