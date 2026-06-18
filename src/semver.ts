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
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`invalid semantic version: "${v}"`);
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

export function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
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
