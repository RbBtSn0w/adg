# Schema Version Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record privacy-safe manifest schema, lock format, and successful lock migration version events on the active ADG trace.

**Architecture:** Add one fail-open event helper to `src/telemetry.ts`, then call it at the manifest and lock parsing boundaries. The explicit migration path records both its direct lock read and a success event after the v3 lock has been written.

**Tech Stack:** TypeScript, Node.js test runner, OpenTelemetry API

---

### Task 1: Fail-open telemetry event helper

**Files:**
- Modify: `src/telemetry.ts`
- Create: `test/telemetry.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create a span stub that captures `addEvent` calls and assert that
`recordTelemetryEvent("adg.manifest.read", { "schema.version": "adg.plugin/v1" }, span)`
forwards the event. Add a throwing stub and assert the helper does not throw.

- [ ] **Step 2: Verify RED**

Run: `node --test test/telemetry.test.ts`

Expected: FAIL because `recordTelemetryEvent` is not exported.

- [ ] **Step 3: Implement the helper**

Add this boundary to `src/telemetry.ts`:

```ts
export function recordTelemetryEvent(
  name: string,
  attributes: Attributes,
  span: Pick<Span, "addEvent"> | undefined = opentelemetry.trace.getActiveSpan(),
): void {
  try {
    span?.addEvent(name, attributes);
  } catch {
    // Telemetry must never change CLI behavior.
  }
}
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/telemetry.test.ts`

Expected: all telemetry helper tests pass.

### Task 2: Manifest and lock read events

**Files:**
- Modify: `src/manifest.ts`
- Modify: `src/lock.ts`
- Modify: `test/telemetry.test.ts`

- [ ] **Step 1: Write failing integration tests**

Activate the span stub with `context.with(trace.setSpan(...))`, call
`readManifest()` and `readLock()`, and assert these events:

```ts
{ name: "adg.manifest.read", attributes: { "schema.version": "adg.plugin/v1" } }
{ name: "adg.lock.read", attributes: { "format.version": 3 } }
```

Also assert an unsupported v2 read records `format.version: 2` before throwing.

- [ ] **Step 2: Verify RED**

Run: `node --test test/telemetry.test.ts`

Expected: FAIL because parsing does not emit events.

- [ ] **Step 3: Record observed versions at parsing boundaries**

After JSON parsing and before validation, call `recordTelemetryEvent` only when
the observed version is a valid OTel scalar (`string` for manifest schema,
`number` for lock format). Do not include names, paths, source data, plugin
versions, or selections.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/telemetry.test.ts test/manifest.test.ts test/paths.test.ts`

Expected: all selected tests pass.

### Task 3: Successful migration event

**Files:**
- Modify: `src/commands/migrate.ts`
- Modify: `test/telemetry.test.ts`

- [ ] **Step 1: Write failing migration event test**

Run a minimal v2-to-v3 migration under the active span stub and assert:

```ts
{ name: "adg.lock.read", attributes: { "format.version": 2 } }
{ name: "adg.lock.migrate", attributes: { "from.version": 2, "to.version": 3 } }
```

The existing retry test remains proof that failed migration does not write v3;
add an assertion that it emits no `adg.lock.migrate` event.

- [ ] **Step 2: Verify RED**

Run: `node --test test/telemetry.test.ts test/migrate.test.ts`

Expected: FAIL because migration does not emit events.

- [ ] **Step 3: Emit migration telemetry after durable success**

Record the direct v2 lock read after parsing. Record `adg.lock.migrate` only
after `writeLock()` succeeds, with numeric `from.version` and `to.version`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/telemetry.test.ts test/migrate.test.ts`

Expected: all selected tests pass.

### Task 4: Completion gates

**Files:**
- Verify all changed source, tests, schemas, and documentation

- [ ] **Step 1: Check formatting and generated build**

Run: `git diff --check && npm run typecheck && npm run build`

Expected: exit code 0.

- [ ] **Step 2: Check vendored dependency contract**

Run: `npm run check:vendor-deps`

Expected: exit code 0.

- [ ] **Step 3: Run the complete suite**

Run: `npm test`

Expected: zero failed tests.

- [ ] **Step 4: Reproduce the original global read safely**

Run: `node bin/adg.ts plugins list -g`

Expected: the real v2 store remains unchanged and the error gives the explicit
`plugins migrate` recovery command. Do not execute migration against the real
global store without separate user authorization.
