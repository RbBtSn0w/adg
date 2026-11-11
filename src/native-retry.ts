import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveAgents, type Agent, type AgentScope, type AgentSyncResult } from "./agents/index.ts";
import { readLock, writeLock } from "./lock.ts";
import { installedPluginDir, lockPath } from "./paths.ts";
import { readManifest } from "./manifest.ts";
import { folderHash } from "./hash.ts";
import { effectivePackageFilter } from "./materialize.ts";
import { PROJECTION_DIRS } from "./package.ts";
import { pluginState, resolveSelectionDependencies, type PluginSource } from "./types.ts";
import { withStoreMutex } from "./store-mutex.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import type { UpdatePhase } from "./render/progress.ts";

type NativeOperation = "activate" | "refresh";
interface Request {
  agent: string;
  plugin: string;
  scope: AgentScope;
  origin: PluginSource;
  installedHash: string;
  kind: NativeOperation;
  preserveRuntimeDisabled: boolean;
  started: boolean;
  /** Original lexical path owns the agent marketplace namespace. */
  nativeStore?: string;
}
interface Ledger { version: 1; pluginsDir: string; requests: Request[] }
export interface NativeRetryPending {
  source: string;
  ref?: string;
  plugin: string;
  agent: string;
  message: string;
}
export interface NativeRetryResult {
  agents: AgentSyncResult[];
  pending: NativeRetryPending[];
  /** Every recovered group skips its remote probe for this invocation. */
  groups: Array<{ source: string; ref?: string }>;
}
export interface ReplayNativeOptions {
  pluginsDir: string;
  source?: string;
  ref?: string;
  agents?: Agent[];
  onProgress?: (phase: UpdatePhase) => void;
}
export interface NativeSyncOptions {
  pluginsDir: string;
  scope: AgentScope;
  agent: Agent;
  activate: string[];
  refresh: string[];
  preserveRuntimeDisabled?: boolean;
}

function canonical(path: string): string { return existsSync(path) ? realpathSync(path) : resolve(path); }
function privateRoot(): string {
  return resolve(process.env.ADG_NATIVE_RETRY_HOME || (process.env.ADG_MIGRATION_HOME
    ? join(process.env.ADG_MIGRATION_HOME, "native-retries")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "adg", "native-retries")));
}
function ledgerPath(pluginsDir: string): string {
  return join(privateRoot(), `${createHash("sha256").update(canonical(pluginsDir)).digest("hex")}.json`);
}
function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("Native retry state must be private and owned by the current user");
  }
}
function load(pluginsDir: string): Ledger {
  const path = ledgerPath(pluginsDir);
  if (!existsSync(path)) return { version: 1, pluginsDir: canonical(pluginsDir), requests: [] };
  assertPrivate(privateRoot(), true);
  assertPrivate(path, false);
  const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  if (ledger.version !== 1 || ledger.pluginsDir !== canonical(pluginsDir) || !Array.isArray(ledger.requests)
    || ledger.requests.some(request => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.plugin)
      || typeof request.agent !== "string" || !request.agent || !["activate", "refresh"].includes(request.kind)
      || !["user", "project"].includes(request.scope) || typeof request.installedHash !== "string"
      || !request.origin || request.origin.type !== "github" || typeof request.origin.repo !== "string"
      || typeof request.started !== "boolean" || typeof request.preserveRuntimeDisabled !== "boolean"
      || request.nativeStore !== undefined && (!isAbsolute(request.nativeStore) || canonical(request.nativeStore) !== ledger.pluginsDir))) {
    throw new Error("Invalid native retry state");
  }
  for (const request of ledger.requests) request.nativeStore ??= resolve(pluginsDir);
  return ledger;
}
function save(ledger: Ledger): void {
  mkdirSync(privateRoot(), { recursive: true, mode: 0o700 });
  assertPrivate(privateRoot(), true);
  const path = ledgerPath(ledger.pluginsDir);
  if (existsSync(path)) assertPrivate(path, false);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  if (process.platform === "win32") return; // Windows cannot open directories for fsync.
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function sameOrigin(a: PluginSource, b: PluginSource): boolean {
  return a.type === "github" && b.type === "github" && a.repo === b.repo && a.ref === b.ref && a.path === b.path;
}
function group(request: Request): { source: string; ref?: string } {
  const origin = request.origin;
  if (origin.type !== "github") throw new Error("Native retry source is not remote");
  return { source: origin.repo, ...(origin.ref ? { ref: origin.ref } : {}) };
}
function key(request: Request): string { return `${request.agent}\0${request.plugin}\0${request.scope}\0${request.nativeStore ?? ""}`; }
function failure(agent: string, plugin: string, message: string): AgentSyncResult {
  return { agent, affected: [], skipped: false, failures: [{ plugin, stage: "verify", errorType: "NATIVE_RETRY_PENDING", message }] };
}
function merge(agent: string, results: AgentSyncResult[]): AgentSyncResult {
  const result: AgentSyncResult = { agent, affected: [...new Set(results.flatMap(item => item.affected))], skipped: results.every(item => item.skipped) };
  for (const field of ["verified", "unverified", "preservedDisabled"] as const) {
    if (results.some(item => item[field] !== undefined)) result[field] = [...new Set(results.flatMap(item => item[field] ?? []))];
  }
  const failures = results.flatMap(item => item.failures ?? []);
  if (failures.length) result.failures = failures;
  return result;
}

function rememberRuntimeState(ledger: Ledger, request: Request, enabled: boolean): void {
  const lock = readLock(lockPath(ledger.pluginsDir));
  const entry = lock.plugins[request.plugin];
  if (!entry || !sameOrigin(entry.origin, request.origin) || entry.installedHash !== request.installedHash
      || entry.runtimeStates?.[request.agent] === enabled) return;
  lock.plugins[request.plugin] = { ...entry, runtimeStates: { ...entry.runtimeStates, [request.agent]: enabled } };
  const file = lockPath(ledger.pluginsDir);
  writeLock(file, lock);
  // The ledger can be cleared only after the per-runtime intent is durable.
  const fd = openSync(file, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") {
    const directory = openSync(dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

/** Execute one saved batch, durably marking its start before calling an adapter. */
function execute(ledger: Ledger, requests: Request[], agent: Agent): AgentSyncResult {
  const parts: AgentSyncResult[] = [];
  const lock = readLock(lockPath(ledger.pluginsDir));
  const remove = (request: Request): void => { ledger.requests = ledger.requests.filter(item => item !== request); save(ledger); };
  for (const kind of ["activate", "refresh"] as const) {
    const batch: Request[] = [];
    for (const request of requests.filter(item => item.kind === kind)) {
      const entry = lock.plugins[request.plugin];
      if (!entry || !sameOrigin(entry.origin, request.origin) || entry.installedHash !== request.installedHash
        || pluginState(entry) === "disabled") { remove(request); continue; }
      const ctx = { pluginsDir: request.nativeStore ?? ledger.pluginsDir, plugins: [request.plugin], scope: request.scope };
      try {
        const payload = installedPluginDir(ledger.pluginsDir, request.plugin, entry.origin);
        const manifest = existsSync(payload) ? readManifest(payload) : undefined;
        const selection = manifest ? resolveSelectionDependencies(manifest, entry.selection) : entry.selection;
        if (!manifest || folderHash(payload, PROJECTION_DIRS, effectivePackageFilter(manifest, selection)) !== request.installedHash) {
          parts.push(failure(agent.id, request.plugin, "The installed payload no longer matches the saved synchronization request. Restore its managed files or explicitly re-add the plugin before retrying."));
          continue;
        }
        const native = request.preserveRuntimeDisabled || request.started ? agent.inspectPlugins?.(ctx) : undefined;
        if ((request.preserveRuntimeDisabled || request.started) && agent.inspectPlugins && !Array.isArray(native)) {
          parts.push(failure(agent.id, request.plugin, "Native enabled/disabled state could not be inspected; restore native listing and rerun the same ADG update."));
          continue;
        }
        const installed = Array.isArray(native) ? native.find(item => item.name === request.plugin && item.installed) : undefined;
        if ((installed && !installed.enabled)
            || (request.preserveRuntimeDisabled && entry.runtimeStates?.[agent.id] === false && !installed?.enabled)) {
          parts.push({ agent: agent.id, affected: [], skipped: false, preservedDisabled: [request.plugin] });
          rememberRuntimeState(ledger, request, false);
          remove(request); continue;
        }
        if (request.preserveRuntimeDisabled && installed?.enabled && entry.runtimeStates?.[agent.id] === false) {
          // An independently enabled native registration is a newer user choice.
          rememberRuntimeState(ledger, request, true);
        }
        if (request.started && !agent.retrySafeOperations?.includes(request.kind)) {
          if (Array.isArray(native) && !native.some(item => item.name === request.plugin && item.installed)) {
            // Confirmed absence permits a fresh activation after explicit native
            // cleanup, without repeating an unsafe interrupted refresh.
            request.kind = "activate";
            request.started = false;
            save(ledger);
            parts.push(execute(ledger, [request], agent));
          } else {
            parts.push(failure(agent.id, request.plugin, "The previous native operation was interrupted; this adapter cannot safely replay it. Use the native plugin manager to remove its registration, then retry ADG update."));
          }
          continue;
        }
        batch.push(request);
      } catch (error) {
        parts.push(failure(agent.id, request.plugin, error instanceof Error ? error.message : String(error)));
      }
    }
    if (!batch.length) continue;
    // Different saved scopes must never share one native invocation.
    for (const scope of ["project", "user"] as const) {
      const namespaces = new Set(batch.filter(request => request.scope === scope).map(request => request.nativeStore ?? ledger.pluginsDir));
      for (const nativeStore of namespaces) {
        const selected = batch.filter(request => request.scope === scope && (request.nativeStore ?? ledger.pluginsDir) === nativeStore);
        const ctx = { pluginsDir: nativeStore, plugins: selected.map(request => request.plugin), scope };
        try {
          for (const request of selected) request.started = true;
          save(ledger);
          const result = kind === "activate" ? agent.activate(ctx) : agent.refresh(ctx);
          parts.push(result);
          const snapshot = agent.listInstalled?.(ctx);
          for (const request of selected) {
            const failed = result.failures?.some(item => !item.plugin || item.plugin === request.plugin);
            const verified = result.affected.includes(request.plugin) && (result.verified?.includes(request.plugin)
              || (snapshot === undefined || Array.isArray(snapshot) && snapshot.includes(request.plugin)));
            if (result.preservedDisabled?.includes(request.plugin)
              || (!result.skipped && !failed && !result.unverified?.includes(request.plugin) && verified)) {
              rememberRuntimeState(ledger, request, !result.preservedDisabled?.includes(request.plugin));
              remove(request);
            } else if (!failed) parts.push(failure(agent.id, request.plugin, "Native synchronization remains unconfirmed; rerun the same ADG update to resume offline."));
          }
        } catch (error) {
          for (const request of selected) parts.push(failure(agent.id, request.plugin, error instanceof Error ? error.message : String(error)));
        }
      }
    }
  }
  return merge(agent.id, parts);
}

export interface NativeBatchSyncOptions {
  pluginsDir: string;
  scope: AgentScope;
  requests: Array<{ agent: Agent; activate: string[]; refresh: string[]; preserveRuntimeDisabled?: boolean }>;
}

/** Persist every requested native target before the first adapter side effect. */
export async function syncNativeBatchWithRetry(options: NativeBatchSyncOptions): Promise<AgentSyncResult[]> {
  return withStoreMutex(options.pluginsDir, () => {
    const ledger = load(options.pluginsDir);
    const lock = readLock(lockPath(options.pluginsDir));
    const batches = options.requests.map((item) => {
      const requests: Request[] = [];
      const local: Record<NativeOperation, string[]> = { activate: [], refresh: [] };
      if (!item.agent.available()) return { item, requests, local, absent: true };
      for (const kind of ["activate", "refresh"] as const) {
        for (const plugin of new Set(item[kind])) {
          const entry = lock.plugins[plugin];
          if (!entry || pluginState(entry) === "disabled") continue;
          if (entry.origin.type !== "github") { local[kind].push(plugin); continue; }
          const request: Request = {
            agent: item.agent.id, plugin, scope: options.scope, origin: structuredClone(entry.origin),
            installedHash: entry.installedHash, kind, preserveRuntimeDisabled: Boolean(item.preserveRuntimeDisabled), started: false,
            nativeStore: resolve(options.pluginsDir),
          };
          const previous = ledger.requests.find((saved) => key(saved) === key(request));
          if (previous && sameOrigin(previous.origin, request.origin) && previous.installedHash === request.installedHash) {
            requests.push(previous);
          } else {
            ledger.requests = ledger.requests.filter((saved) => key(saved) !== key(request));
            ledger.requests.push(request);
            requests.push(request);
          }
        }
      }
      return { item, requests, local, absent: false };
    });
    if (batches.some((batch) => batch.requests.length)) save(ledger);
    recordTelemetryEvent("adg.native_retry.prepared", { "request.count": batches.reduce((count, batch) => count + batch.requests.length, 0) });
    return batches.map(({ item, requests, local, absent }) => {
      if (absent) return { agent: item.agent.id, affected: [], skipped: true };
      if (!item.agent.available()) {
        return requests.length ? merge(item.agent.id, requests.map((request) => failure(item.agent.id, request.plugin,
          `Saved native target ${item.agent.id} is unavailable; retry with the same runtime to resume offline.`)))
          : { agent: item.agent.id, affected: [], skipped: true };
      }
      const results: AgentSyncResult[] = [];
      if (requests.length) results.push(execute(ledger, requests, item.agent));
      for (const kind of ["activate", "refresh"] as const) {
        if (!local[kind].length) continue;
        const ctx = { pluginsDir: options.pluginsDir, plugins: local[kind], scope: options.scope };
        results.push(kind === "activate" ? item.agent.activate(ctx) : item.agent.refresh(ctx));
      }
      return merge(item.agent.id, results);
    });
  });
}

/** Single-target compatibility wrapper around the batch persistence boundary. */
export async function syncNativeWithRetry(options: NativeSyncOptions): Promise<AgentSyncResult> {
  return (await syncNativeBatchWithRetry({ pluginsDir: options.pluginsDir, scope: options.scope, requests: [options] }))[0]!;
}

/** Replay saved operations from installed payloads before contacting upstream. */
export async function replayNativeRetries(options: ReplayNativeOptions): Promise<NativeRetryResult> {
  return withStoreMutex(options.pluginsDir, () => {
    const ledger = load(options.pluginsDir);
    const requests = ledger.requests.filter(request => {
      const owner = group(request);
      return (!options.source || owner.source === options.source) && (options.ref === undefined || owner.ref === options.ref);
    });
    const groups = [...new Map(requests.map(request => { const owner = group(request); return [JSON.stringify(owner), owner]; })).values()];
    const results: AgentSyncResult[] = [];
    const agents = options.agents ?? resolveAgents();
    const current = readLock(lockPath(options.pluginsDir));
    const live = requests.filter(request => {
      const entry = current.plugins[request.plugin];
      return entry && sameOrigin(entry.origin, request.origin)
        && entry.installedHash === request.installedHash && pluginState(entry) === "enabled";
    });
    if (live.length !== requests.length) {
      ledger.requests = ledger.requests.filter(request => !requests.includes(request) || live.includes(request));
      save(ledger);
    }
    for (const id of new Set(live.map(request => request.agent))) {
      const selected = live.filter(request => request.agent === id);
      const agent = agents.find(item => item.id === id);
      options.onProgress?.({ kind: "activate", agent: id, count: selected.length });
      if (!agent || !agent.available()) {
        results.push(merge(id, selected.map(request => failure(id, request.plugin, `Saved native target ${id} is unavailable; retry with the same runtime to resume offline.`))));
      } else results.push(execute(ledger, selected, agent));
    }
    const remaining = new Set(ledger.requests);
    const pending = requests.filter(request => remaining.has(request)).map(request => ({
      ...group(request), plugin: request.plugin, agent: request.agent,
      message: results.find(result => result.agent === request.agent)?.failures?.find(item => !item.plugin || item.plugin === request.plugin)?.message ?? "Native synchronization remains pending",
    }));
    if (requests.length) recordTelemetryEvent("adg.native_retry.replayed", { "request.count": requests.length, "pending.count": pending.length });
    return { agents: results, groups, pending };
  });
}
