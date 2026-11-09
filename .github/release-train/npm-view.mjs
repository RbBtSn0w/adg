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

// One deadline covers immutable bytes and channel convergence across registries.
// Returning null means a validated observation is still pending, never a read error.
export function createNpmObservationBudget({timeoutMs = 900000, intervalMs = 15000, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('Invalid npm observation budget');
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(0, Math.floor(deadline - now()));
  const pending = () => Object.assign(Error('npm publication availability is not confirmed within the observation budget; preserve the original receipt and artifact'), {code: 'NPM_AVAILABILITY_PENDING'});
  const assertRemaining = () => {const available = remaining(); if (!available) throw pending(); return available;};
  return {remaining, assertRemaining, async wait(read) {
    for (;;) {
      const value = await read(assertRemaining());
      if (value !== null) return value;
      const available = assertRemaining();
      await sleep(Math.min(intervalMs, available));
    }
  }};
}
