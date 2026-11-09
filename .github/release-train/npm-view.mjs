// npm 12 wraps single-field results in an array; npm 11 returns the value.
// A single exact query must never choose between multiple observations.
export function parseNpmView(stdout) {
  const value = JSON.parse(stdout);
  if (!Array.isArray(value)) return value;
  if (value.length !== 1 || Array.isArray(value[0])) {
    throw Error('Ambiguous npm view response: expected a single observation');
  }
  return value[0];
}
