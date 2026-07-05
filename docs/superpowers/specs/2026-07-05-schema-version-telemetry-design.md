# Schema Version Telemetry Design

## Goal

Measure use of plugin manifest schema versions and plugin lock format versions
so compatibility code can be removed using observed adoption data.

## Event Model

Record low-cardinality events on the active root `adg` span:

- `adg.manifest.read` with `schema.version` and
  `manifest.layout=canonical|legacy`
- `adg.lock.read` with `format.version`
- `adg.lock.migrate` with `from.version` and `to.version`

Do not record plugin names, plugin versions, filesystem paths, source URLs, or
selection contents. Commands that read multiple manifests emit one event per
read so mixed-version usage remains measurable. Unknown schema and lock
versions use fixed `other`/`-1` buckets to prevent untrusted values from
creating high-cardinality telemetry.

## Boundaries

Manifest validation and lock parsing remain responsible for correctness. A
small telemetry helper only looks up the active span and adds an event. With
telemetry disabled or no active span, recording is a no-op. Telemetry failures
must never change CLI behavior.

Migration records its event only after the v3 lock is written successfully.
Unsupported lock reads still record the observed version before failing, since
that population is the evidence needed to retain or remove migration support.

## Verification

Unit tests use an active in-memory span stub to verify event names and
attributes. Existing migration tests verify successful and retryable v2-to-v3
conversion. Full typecheck, build, vendor dependency check, and test suite are
required before completion.
