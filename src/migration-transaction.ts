import {
  chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Agent, AgentScope, AgentSyncResult } from "./agents/types.ts";
import { LOCK_VERSION, type LockEntry, type PluginLock, type SourceIntent } from "./types.ts";
import { readLock } from "./lock.ts";
import { readMarketplace, removeMarketplacePlugin, upsertMarketplacePlugin } from "./marketplace.ts";
import {
  installedPluginDir, lockPath, marketplacePath, marketplaceSourcePath,
  pluginDir, pluginSourceCacheDir,
} from "./paths.ts";
import { ADAPTER_TARGETS, type AdapterTarget } from "./adapters/index.ts";
import { adaptPlugin } from "./commands/adapt.ts";
import { readManifest } from "./manifest.ts";
import { folderHash } from "./hash.ts";
import { recordTelemetryEvent } from "./telemetry.ts";
import { withStoreMutex } from "./store-mutex.ts";

export interface PreparedMigrationPlugin {
  name: string;
  dir: string;
  entry: LockEntry;
  cacheDir?: string;
  runtimeRefreshRequired?: boolean;
}

export interface MigrationSuccessor {
  name: string;
  predecessors: string[];
  /** Explicit user decisions; an absent target preserves inherited native state. */
  enabledByTarget?: Record<string, boolean>;
}

export interface PrepareMigrationOptions {
  pluginsDir: string;
  source: string;
  ref?: string;
  revision: string;
  prepared: PreparedMigrationPlugin[];
  retire: string[];
  scope: AgentScope;
  targets?: Agent[];
  retireTargets?: Agent[];
  successors?: MigrationSuccessor[];
  projectionTargets?: AdapterTarget[];
  refreshExisting?: { name: string; target: string }[];
  sourceIntent?: SourceIntent;
}

interface Operation {
  agent: string;
  plugin: string;
  kind: "activate" | "refresh" | "disable" | "retire" | "ensure";
  successor?: { predecessors: string[]; requiredTarget: boolean; forceRefresh: boolean; enabledByTarget?: Record<string, boolean> };
  desiredEnabled?: boolean;
  notApplicable?: boolean;
  done: boolean;
  started?: boolean;
}

interface PreparedRecord {
  name: string;
  entry: LockEntry;
  cache: boolean;
  dest: string;
  payloadHash: string;
  cacheHash?: string;
  category?: string;
}

interface Journal {
  version: 1;
  pluginsDir: string;
  cacheStore?: string;
  source: string;
  ref?: string;
  revision: string;
  scope: AgentScope;
  prepared: PreparedRecord[];
  refreshExisting?: { name: string; target: string }[];
  successors?: MigrationSuccessor[];
  retire: string[];
  sourceIntent?: SourceIntent;
  before: PluginLock;
  operations: Operation[];
  published: boolean;
  complete: boolean;
}

export interface MigrationTargetStateDecision {
  agent: string;
  plugin: string;
  enabled: boolean;
}

export interface PublishMigrationOptions {
  targets?: Agent[];
  stateDecisions?: MigrationTargetStateDecision[];
}

export interface MigrationPublishResult {
  complete: boolean;
  journalPath: string;
  failures: { message: string }[];
  agents?: AgentSyncResult[];
  stateDecisions?: { agent: string; plugin: string }[];
}

function syncPath(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    if (process.platform === "win32") return;
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return;
  }
  let restoreMode: number | undefined;
  let fd: number | undefined;
  try {
    // Windows FlushFileBuffers needs GENERIC_WRITE. Only owned snapshots and
    // published files reach this helper; source files are never chmodded.
    if (process.platform === "win32" && !(stat.mode & 0o200)) {
      restoreMode = stat.mode & 0o777;
      chmodSync(path, restoreMode | 0o200);
    }
    fd = openSync(path, process.platform === "win32" ? "r+" : "r");
    if (restoreMode !== undefined) {
      chmodSync(path, restoreMode);
      restoreMode = undefined;
    }
    fsyncSync(fd);
  } finally {
    try { if (restoreMode !== undefined) chmodSync(path, restoreMode); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
  }
  syncPath(path);
}

/** Rename within the destination filesystem, retaining durable recovery inputs. */
function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  syncPath(dirname(file));
}

function privateRoot(): string {
  return resolve(process.env.ADG_MIGRATION_HOME || join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "adg", "migrations",
  ));
}

function canonicalStore(pluginsDir: string): string {
  return existsSync(pluginsDir) ? realpathSync(pluginsDir) : resolve(pluginsDir);
}

function rootFor(pluginsDir: string): string {
  const identity = createHash("sha256").update(canonicalStore(pluginsDir)).digest("hex");
  return join(privateRoot(), identity);
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()
      || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("Migration state directory must be private and owned by the current user.");
  }
}

function assertName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error("Invalid migration plugin identity");
}

function safeDestination(pluginsDir: string, name: string, entry: LockEntry): string {
  assertName(name);
  const dest = resolve(pluginDir(pluginsDir, name, entry.origin));
  const rel = relative(pluginsDir, dest);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Migration destination escapes the store");
  let cursor = dirname(dest);
  while (cursor !== pluginsDir) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Migration destination crosses a symbolic link");
    }
    cursor = dirname(cursor);
  }
  return dest;
}

function assertSourceOwner(source: string, ref: string | undefined, entry: LockEntry): void {
  const origin = entry.origin;
  const key = origin.type === "local" ? "(local)" : origin.type === "github" ? origin.repo : origin.url;
  const same = origin.type === "github" ? key.toLowerCase() === source.toLowerCase() : key === source;
  const originRef = origin.type === "local" ? undefined : origin.ref;
  if (!same || originRef !== ref) throw new Error("Migration source/ref does not own a replaced or retired plugin");
}

function validateTargetDecisions(value: unknown, allowed?: Set<string>): asserts value is Record<string, boolean> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("Successor enabledByTarget must be a plain boolean record");
  }
  for (const [target, enabled] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target) || ["__proto__", "constructor", "prototype"].includes(target)
        || typeof enabled !== "boolean" || (allowed && !allowed.has(target))) {
      throw new Error("Invalid or unauthorized successor target state decision");
    }
  }
}

function explicitTargetDecision(op: Operation, agent: string): boolean | undefined {
  return op.successor?.enabledByTarget && Object.hasOwn(op.successor.enabledByTarget, agent)
    ? op.successor.enabledByTarget[agent] : undefined;
}

function existingProjectionTargets(dir: string): AdapterTarget[] {
  return ADAPTER_TARGETS.filter((target) => existsSync(join(dir, target === "antigravity" ? "plugin.json" : `.${target}-plugin/plugin.json`)));
}

function load(path: string): Journal {
  const resolved = resolve(path);
  const base = privateRoot();
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 3 || basename(resolved) !== "journal.json") {
    throw new Error("Untrusted migration journal path");
  }
  assertPrivateDirectory(base);
  assertPrivateDirectory(dirname(dirname(resolved)));
  assertPrivateDirectory(dirname(resolved));
  if (lstatSync(resolved).isSymbolicLink()) throw new Error("Untrusted migration journal");
  const journal = JSON.parse(readFileSync(resolved, "utf8")) as Journal;
  if (journal.version !== 1 || journal.pluginsDir !== canonicalStore(journal.pluginsDir)
      || dirname(dirname(resolved)) !== rootFor(journal.pluginsDir)) {
    throw new Error("Migration store identity mismatch");
  }
  if (journal.cacheStore && (!isAbsolute(journal.cacheStore) || (!journal.complete && canonicalStore(journal.cacheStore) !== journal.pluginsDir))) {
    throw new Error("Migration cache store identity mismatch");
  }
  for (const p of journal.prepared) {
    assertSourceOwner(journal.source, journal.ref, p.entry);
    if (p.dest !== safeDestination(journal.pluginsDir, p.name, p.entry)) throw new Error("Migration destination mismatch");
  }
  for (const name of journal.retire) {
    assertName(name);
    const entry = journal.before.plugins[name];
    if (entry) {
      assertSourceOwner(journal.source, journal.ref, entry);
      safeDestination(journal.pluginsDir, name, entry);
    }
  }
  for (const request of journal.refreshExisting ?? []) {
    assertName(request.name);
    const entry = journal.before.plugins[request.name];
    if (!entry || journal.retire.includes(request.name)) throw new Error("Invalid surviving native repair identity");
    assertSourceOwner(journal.source, journal.ref, entry);
  }
  for (const successor of journal.successors ?? []) {
    assertName(successor.name);
    validateTargetDecisions(successor.enabledByTarget);
    const entry = journal.prepared.find((p) => p.name === successor.name)?.entry ?? journal.before.plugins[successor.name];
    if (!entry || journal.retire.includes(successor.name)) throw new Error("Invalid required successor");
    assertSourceOwner(journal.source, journal.ref, entry);
    for (const name of successor.predecessors) {
      assertName(name);
      if (!journal.before.plugins[name]) throw new Error("Invalid successor predecessor");
      assertSourceOwner(journal.source, journal.ref, journal.before.plugins[name]!);
    }
  }
  for (const op of journal.operations) validateTargetDecisions(op.successor?.enabledByTarget);
  return journal;
}

export function discoverPendingMigrations(pluginsDir: string): { journalPath: string; source: string; ref?: string }[] {
  const root = rootFor(pluginsDir);
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((id) => {
    const journalPath = join(root, id, "journal.json");
    if (!existsSync(journalPath)) return [];
    const journal = load(journalPath);
    if (journal.complete) {
      // Leave a receipt for callers replaying the completed transaction. Only
      // retry filesystem cleanup if publication was interrupted after commit.
      if (readdirSync(dirname(journalPath)).some(name => name !== "journal.json")) cleanupArtifacts(dirname(journalPath));
      return [];
    }
    return [{ journalPath, source: journal.source, ...(journal.ref ? { ref: journal.ref } : {}) }];
  });
}

/** Prepare all durable inputs before touching the live lock or native targets. */
export async function prepareMigrationTransaction(options: PrepareMigrationOptions): Promise<string> {
  return await withStoreMutex(options.pluginsDir, () => {
    mkdirSync(options.pluginsDir, { recursive: true });
    const pluginsDir = canonicalStore(options.pluginsDir);
    const nativePluginsDir = resolve(options.pluginsDir);
    if (!options.revision) throw new Error("Migration requires a fixed revision.");
    const names = new Set<string>();
    for (const p of options.prepared) {
      assertName(p.name);
      if (names.has(p.name)) throw new Error("Duplicate migration plugin name.");
      names.add(p.name);
      safeDestination(pluginsDir, p.name, p.entry);
    }
    for (const name of options.retire) {
      assertName(name);
      if (names.has(name)) throw new Error("Migration successor cannot also be retired.");
    }
    const touched = new Set([...names, ...options.retire, ...(options.successors ?? []).flatMap((item) => [item.name, ...item.predecessors]), ...(options.refreshExisting ?? []).map((request) => request.name)]);
    const dependencies = new Set(options.prepared.flatMap((p) => Object.keys(p.entry.dependencies ?? {})));
    for (const pending of discoverPendingMigrations(pluginsDir)) {
      const peer = load(pending.journalPath);
      const protectedNames = new Set([...peer.prepared.map((p) => p.name), ...peer.retire, ...(peer.successors ?? []).flatMap((item) => [item.name, ...item.predecessors]), ...(peer.refreshExisting ?? []).map((request) => request.name)]);
      const peerDependencies = peer.prepared.flatMap((p) => Object.keys(p.entry.dependencies ?? {}));
      if ((peer.source.toLowerCase() === options.source.toLowerCase() && peer.ref === options.ref)
          || [...touched].some((name) => protectedNames.has(name))
          || [...dependencies].some((name) => protectedNames.has(name))
          || peerDependencies.some((name) => touched.has(name))) {
        throw new Error("Resume the pending migration before modifying its source/ref, protected plugins, or dependencies.");
      }
    }
    const before = readLock(lockPath(pluginsDir));
    for (const [name, entry] of Object.entries(before.plugins)) {
      if (!touched.has(name) && Object.keys(entry.dependencies ?? {}).some((dependency) => options.retire.includes(dependency))) {
        throw new Error("Migration retirement would orphan a dependency of an unchanged plugin");
      }
    }
    for (const p of options.prepared) {
      assertSourceOwner(options.source, options.ref, p.entry);
      if (before.plugins[p.name]) assertSourceOwner(options.source, options.ref, before.plugins[p.name]!);
    }
    for (const name of options.retire) if (before.plugins[name]) assertSourceOwner(options.source, options.ref, before.plugins[name]!);
    for (const request of options.refreshExisting ?? []) {
      assertName(request.name);
      if (!before.plugins[request.name] || options.retire.includes(request.name)) throw new Error("Native repair must reference an existing surviving plugin");
      assertSourceOwner(options.source, options.ref, before.plugins[request.name]!);
    }
    const decisionTargets = new Set([...(options.targets ?? []), ...(options.retire.length ? options.retireTargets ?? [] : [])].map((target) => target.id));
    for (const successor of options.successors ?? []) {
      assertName(successor.name);
      validateTargetDecisions(successor.enabledByTarget, decisionTargets);
      const entry = options.prepared.find((p) => p.name === successor.name)?.entry ?? before.plugins[successor.name];
      if (!entry || options.retire.includes(successor.name)) throw new Error("Required successor must survive the transaction");
      assertSourceOwner(options.source, options.ref, entry);
      for (const name of successor.predecessors) {
        assertName(name);
        if (!before.plugins[name]) throw new Error("Required successor has no installed predecessor");
        assertSourceOwner(options.source, options.ref, before.plugins[name]!);
      }
    }
    if (options.sourceIntent && (options.sourceIntent.source !== options.source || options.sourceIntent.ref !== options.ref)) {
      throw new Error("Migration source intent belongs to another source/ref");
    }
    const root = join(rootFor(pluginsDir), randomUUID());
    mkdirSync(privateRoot(), { recursive: true, mode: 0o700 });
    assertPrivateDirectory(privateRoot());
    mkdirSync(rootFor(pluginsDir), { recursive: true, mode: 0o700 });
    assertPrivateDirectory(rootFor(pluginsDir));
    mkdirSync(root, { mode: 0o700 });
    try {
      const operations: Operation[] = [];
      const targets = (options.targets ?? []).filter((target) => target.detect());
      const retirementTargets = options.retire.length ? [...new Map([...targets, ...(options.retireTargets ?? []).filter((target) => target.detect())].map((target) => [target.id, target])).values()] : targets;
      const successorNames = new Set((options.successors ?? []).map((item) => item.name));
      const prepared = options.prepared.map((p, index): PreparedRecord => {
        const dir = join(root, "payload", String(index));
        mkdirSync(dirname(dir), { recursive: true });
        cpSync(p.dir, dir, { recursive: true, dereference: false });
        const manifest = readManifest(dir);
        if (manifest.name !== p.name) throw new Error("Prepared migration plugin identity does not match its manifest");
        const dest = safeDestination(pluginsDir, p.name, p.entry);
        // Generated files must refer to their eventual live location, even offline.
        const projectionTargets = options.projectionTargets ?? [...new Set([
          ...existingProjectionTargets(dir), ...(options.targets ?? []).map((t) => t.adaptTarget),
        ])];
        adaptPlugin(dir, projectionTargets, p.entry.selection, dest);
        syncTree(dir);
        let cacheHash: string | undefined;
        if (p.cacheDir) {
          const cache = join(root, "cache", String(index));
          mkdirSync(dirname(cache), { recursive: true });
          cpSync(p.cacheDir, cache, { recursive: true, dereference: false });
          syncTree(cache);
          cacheHash = folderHash(cache);
        }
        const previousRuntime = before.plugins[p.name]?.runtimeStates;
        const entry: LockEntry = { ...p.entry,
          ...(previousRuntime || p.entry.runtimeStates ? { runtimeStates: { ...previousRuntime, ...p.entry.runtimeStates } } : {}) };
        for (const target of p.runtimeRefreshRequired === false || successorNames.has(p.name) ? [] : targets) {
          const observed = target.available()
            ? target.inspectPlugins?.({ pluginsDir: nativePluginsDir, plugins: [p.name], scope: options.scope }) : undefined;
          const native = Array.isArray(observed) ? observed.find((r) => r.name === p.name && r.installed) : undefined;
          if (entry.state === "disabled") {
            if (native?.enabled || (!Array.isArray(observed) && before.plugins[p.name])) {
              operations.push({ agent: target.id, plugin: p.name, kind: "disable", desiredEnabled: false, done: false });
            } else operations.push({ agent: target.id, plugin: p.name, kind: "disable", desiredEnabled: false, done: true });
            continue;
          }
          if ((native && !native.enabled) || (!native && entry.runtimeStates?.[target.id] === false)) {
            operations.push({ agent: target.id, plugin: p.name, kind: "disable", desiredEnabled: false, done: true });
            continue;
          }
          operations.push({ agent: target.id, plugin: p.name, kind: before.plugins[p.name] ? "refresh" : "activate", desiredEnabled: true, done: false });
        }
        return { name: p.name, entry, cache: !!p.cacheDir, dest, payloadHash: folderHash(dir), cacheHash, category: manifest.category };
      });
      for (const request of options.refreshExisting ?? []) {
        const target = targets.find((agent) => agent.id === request.target);
        const entry = before.plugins[request.name]!;
        if (!target || successorNames.has(request.name) || entry.state === "disabled" || operations.some((op) => op.agent === target.id && op.plugin === request.name)) continue;
        const inspected = target.available() ? target.inspectPlugins?.({ pluginsDir: nativePluginsDir, plugins: [request.name], scope: options.scope }) : undefined;
        const native = Array.isArray(inspected) ? inspected.find((record) => record.name === request.name && record.installed) : undefined;
        if ((native && !native.enabled) || (!native && entry.runtimeStates?.[target.id] === false)) {
          operations.push({ agent: target.id, plugin: request.name, kind: "disable", desiredEnabled: false, done: true });
          continue;
        }
        operations.push({ agent: target.id, plugin: request.name, kind: "refresh", desiredEnabled: true, done: false });
      }
      for (const successor of options.successors ?? []) {
        for (const target of retirementTargets) {
          operations.push({ agent: target.id, plugin: successor.name, kind: "ensure", done: false,
            successor: { predecessors: successor.predecessors, requiredTarget: targets.some((item) => item.id === target.id),
              forceRefresh: options.prepared.some((p) => p.name === successor.name && p.runtimeRefreshRequired !== false),
              ...(successor.enabledByTarget ? { enabledByTarget: { ...successor.enabledByTarget } } : {}) } });
        }
      }
      for (const name of options.retire) {
        if (before.plugins[name]) {
          for (const target of retirementTargets) operations.push({ agent: target.id, plugin: name, kind: "retire", done: false });
        }
      }
      atomicJson(join(root, "before-lock.json"), before);
      if (existsSync(marketplacePath(pluginsDir))) {
        cpSync(marketplacePath(pluginsDir), join(root, "before-marketplace.json"));
        syncPath(join(root, "before-marketplace.json"));
      }
      const journal: Journal = {
        version: 1, pluginsDir, cacheStore: resolve(options.pluginsDir), source: options.source, ref: options.ref, revision: options.revision,
        scope: options.scope, prepared, successors: options.successors ? structuredClone(options.successors) : undefined, refreshExisting: options.refreshExisting, retire: options.retire, sourceIntent: options.sourceIntent,
        before, operations, published: false, complete: false,
      };
      const after = metadataFor(journal, true);
      atomicJson(join(root, "after-lock.json"), after.lock);
      atomicJson(join(root, "after-marketplace.json"), after.market);
      const path = join(root, "journal.json");
      atomicJson(path, journal);
      syncPath(rootFor(pluginsDir));
      syncPath(privateRoot());
      recordTelemetryEvent("adg.migration.prepared", { "plugin.count": prepared.length, "target.count": targets.length });
      return path;
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
}

function metadataFor(journal: Journal, retire: boolean) {
  const lock = readLock(lockPath(journal.pluginsDir));
  const market = readMarketplace(marketplacePath(journal.pluginsDir), basename(journal.pluginsDir));
  for (const p of journal.prepared) {
    lock.plugins[p.name] = p.entry;
    upsertMarketplacePlugin(market, {
      name: p.name,
      source: { source: "local", path: marketplaceSourcePath(journal.pluginsDir, p.dest) },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      ...(p.category ? { category: p.category } : {}),
    });
  }
  if (retire) {
    for (const name of journal.retire) {
      delete lock.plugins[name];
      removeMarketplacePlugin(market, name);
    }
    if (lock.lastSelected) lock.lastSelected = lock.lastSelected.filter((n) => !journal.retire.includes(n));
    const intent = journal.sourceIntent;
    if (intent) {
      lock.sources = (lock.sources ?? []).filter((s) => s.source !== intent.source || s.ref !== intent.ref);
      lock.sources.push(intent);
    }
  }
  for (const op of journal.operations) {
    const entry = lock.plugins[op.plugin];
    if (entry && op.done && !op.notApplicable && op.kind !== "retire" && typeof op.desiredEnabled === "boolean") {
      lock.plugins[op.plugin] = { ...entry, runtimeStates: { ...entry.runtimeStates, [op.agent]: op.desiredEnabled } };
    }
  }
  return { lock, market };
}

function publishMetadata(journal: Journal, retire: boolean): void {
  const { lock, market } = metadataFor(journal, retire);
  atomicJson(lockPath(journal.pluginsDir), lock);
  atomicJson(marketplacePath(journal.pluginsDir), market);
}

/** Keep the caller's lexical namespace and canonical aliases coherent. */
function cacheStores(journal: Journal): string[] {
  return [...new Set([journal.cacheStore ?? journal.pluginsDir, journal.pluginsDir])];
}

function publishPayloads(journal: Journal, root: string): void {
  for (const [index, p] of journal.prepared.entries()) {
    const staged = join(root, "payload", String(index));
    if (folderHash(staged) !== p.payloadHash) throw new Error("Migration payload integrity check failed");
    if (p.cache && folderHash(join(root, "cache", String(index))) !== p.cacheHash) {
      throw new Error("Migration source cache integrity check failed");
    }
    const swap = `${p.dest}.migration-${basename(root)}`;
    mkdirSync(dirname(p.dest), { recursive: true });
    rmSync(swap, { recursive: true, force: true });
    cpSync(staged, swap, { recursive: true, dereference: false });
    syncTree(swap);
    if (existsSync(p.dest)) {
      const backup = join(root, "previous", String(index));
      mkdirSync(dirname(backup), { recursive: true });
      // Keep the original payload when replaying a partially published store.
      if (!existsSync(backup)) cpSync(p.dest, backup, { recursive: true, dereference: false });
      syncTree(backup);
      rmSync(p.dest, { recursive: true, force: true });
    }
    renameSync(swap, p.dest);
    syncPath(dirname(p.dest));
    if (p.cache) for (const [cacheIndex, cacheStore] of cacheStores(journal).entries()) {
      const cache = pluginSourceCacheDir(cacheStore, p.name);
      mkdirSync(dirname(cache), { recursive: true });
      const temp = `${cache}.migration-${basename(root)}`;
      rmSync(temp, { recursive: true, force: true });
      cpSync(join(root, "cache", String(index)), temp, { recursive: true, dereference: false });
      syncTree(temp);
      if (existsSync(cache)) {
        const backup = join(root, "previous-cache", String(index), String(cacheIndex));
        mkdirSync(dirname(backup), { recursive: true });
        if (!existsSync(backup)) cpSync(cache, backup, { recursive: true, dereference: false });
        syncTree(backup);
      }
      rmSync(cache, { recursive: true, force: true });
      renameSync(temp, cache);
      syncPath(dirname(cache));
    }
  }
}

function nativeStore(journal: Journal): string {
  return journal.cacheStore ?? journal.pluginsDir;
}

function proveInterruptedOperation(journal: Journal, op: Operation, agent: Agent): boolean {
  const details = agent.inspectPlugins?.({ pluginsDir: nativeStore(journal), plugins: [op.plugin], scope: journal.scope });
  if (!Array.isArray(details)) return false;
  if (op.kind === "retire" || op.kind === "disable") return !details.some((p) => p.name === op.plugin && p.installed);
  const desired = journal.prepared.find((p) => p.name === op.plugin)?.entry ?? journal.before.plugins[op.plugin];
  const previous = journal.before.plugins[op.plugin];
  return details.some((p) => p.name === op.plugin && p.installed && p.enabled && p.version === desired?.version)
    && (op.kind !== "refresh" || previous?.version !== desired?.version);
}

function successorEntry(journal: Journal, name: string): LockEntry | undefined {
  return journal.prepared.find((p) => p.name === name)?.entry ?? journal.before.plugins[name];
}

class NativeStateDecisionRequired extends Error {
  readonly agent: string;
  readonly plugin: string;
  constructor(agent: string, plugin: string) {
    super(`Predecessors have mixed enabled/disabled state in ${agent}; choose the successor state before retiring them.`);
    this.agent = agent;
    this.plugin = plugin;
  }
}

function applyStateDecisions(journal: Journal, decisions: MigrationTargetStateDecision[]): void {
  const unique = new Map<string, MigrationTargetStateDecision>();
  for (const decision of decisions) {
    assertName(decision.plugin);
    validateTargetDecisions({ [decision.agent]: decision.enabled });
    const op = journal.operations.find((item) => item.agent === decision.agent && item.plugin === decision.plugin);
    const successor = journal.successors?.find((item) => item.name === decision.plugin);
    if (!op?.successor || op.kind !== "ensure" || op.done || !successor) {
      throw new Error("Native state decision must address an existing pending successor target");
    }
    const key = `${decision.agent}\0${decision.plugin}`;
    const previous = unique.get(key);
    if (previous && previous.enabled !== decision.enabled) throw new Error("Conflicting native successor state decisions");
    unique.set(key, decision);
  }
  for (const decision of unique.values()) {
    const op = journal.operations.find((item) => item.agent === decision.agent && item.plugin === decision.plugin)!;
    const successor = journal.successors!.find((item) => item.name === decision.plugin)!;
    (op.successor!.enabledByTarget ??= {})[decision.agent] = decision.enabled;
    (successor.enabledByTarget ??= {})[decision.agent] = decision.enabled;
  }
}

/** Determine per-target intent while every predecessor registration is retained. */
function resolveSuccessorOperation(journal: Journal, op: Operation, agent: Agent): void {
  const requirement = op.successor!;
  op.notApplicable = false;
  const names = [...new Set([op.plugin, ...requirement.predecessors])];
  const ctx = { pluginsDir: nativeStore(journal), plugins: names, scope: journal.scope };
  const records = agent.inspectPlugins?.(ctx);
  if (!Array.isArray(records)) throw new Error(`Cannot inspect successor/predecessor state in ${agent.id}; predecessor retirement remains pending.`);
  const successor = records.find((item) => item.name === op.plugin && item.installed);
  const predecessorStates = requirement.predecessors.flatMap((name): boolean[] => {
    const native = records.find((item) => item.name === name && item.installed);
    if (native) return [native.enabled];
    // A disabled inherited successor may intentionally never have a native
    // registration. Its saved per-runtime intent must survive another rename.
    const previous = journal.before.plugins[name];
    const saved = previous?.runtimeStates?.[agent.id];
    if (typeof saved === "boolean") return [saved];
    return previous?.state === "disabled" ? [false] : [];
  });
  const desired = successorEntry(journal, op.plugin)!;
  let enabled = desired.state !== "disabled";
  const independentlyInstalled = Boolean(journal.before.plugins[op.plugin]) && Boolean(successor?.enabled)
    && !requirement.predecessors.includes(op.plugin);
  const explicit = explicitTargetDecision(op, agent.id);
  if (explicit !== undefined) enabled = explicit;
  else if (successor && !successor.enabled) enabled = false;
  else if (independentlyInstalled) enabled = desired.state !== "disabled";
  else if (typeof desired.runtimeStates?.[agent.id] === "boolean") enabled = enabled && desired.runtimeStates[agent.id]!;
  else if (predecessorStates.length) {
    if (predecessorStates.includes(true) && predecessorStates.includes(false)) {
      throw new NativeStateDecisionRequired(agent.id, op.plugin);
    }
    enabled = enabled && predecessorStates.includes(true);
  }
  op.desiredEnabled = enabled;
  if (explicit === undefined && !requirement.requiredTarget && !predecessorStates.length && !successor) { op.notApplicable = true; op.done = true; return; }
  if (!enabled) {
    if (!successor || !successor.enabled) op.done = true;
    else op.kind = "disable";
    return;
  }
  const stale = agent.needsProjectionRefresh?.({ ...ctx, plugins: [op.plugin] }).includes(op.plugin) ?? false;
  if (successor?.enabled && successor.version === desired.version && !stale && !requirement.forceRefresh) {
    op.done = true;
    return;
  }
  op.kind = successor ? "refresh" : "activate";
}

function verifySuccessor(journal: Journal, op: Operation, agent: Agent): boolean {
  if (!op.successor || op.notApplicable) return true;
  const ctx = { pluginsDir: nativeStore(journal), plugins: [op.plugin], scope: journal.scope };
  const records = agent.inspectPlugins?.(ctx);
  if (!Array.isArray(records)) return false;
  const native = records.find((item) => item.name === op.plugin && item.installed);
  if (!op.desiredEnabled) return !native || !native.enabled;
  return !!native?.enabled && native.version === successorEntry(journal, op.plugin)?.version
    && !(agent.needsProjectionRefresh?.(ctx).includes(op.plugin));
}

function mergeAgentReports(parts: AgentSyncResult[]): AgentSyncResult[] {
  return [...new Set(parts.map((part) => part.agent))].map((agent) => {
    const items = parts.filter((part) => part.agent === agent);
    const result: AgentSyncResult = {
      agent, affected: [...new Set(items.flatMap((part) => part.affected))], skipped: items.every((part) => part.skipped),
    };
    for (const field of ["verified", "unverified", "preservedDisabled"] as const) {
      const values = [...new Set(items.flatMap((part) => part[field] ?? []))];
      if (values.length) result[field] = values;
    }
    const failures = items.flatMap((part) => part.failures ?? []);
    if (failures.length) result.failures = [...new Map(failures.map((failure) => [JSON.stringify(failure), failure])).values()];
    return result;
  });
}

function cleanupArtifacts(root: string): void {
  for (const name of ["payload", "cache", "previous", "previous-cache", "before-lock.json", "before-marketplace.json", "after-lock.json", "after-marketplace.json"]) {
    rmSync(join(root, name), { recursive: true, force: true });
  }
  syncPath(root);
}

/** Offline replay: never resolves a source or selects a newer revision. */
export async function publishMigrationTransaction(
  journalPath: string, options: PublishMigrationOptions = {},
): Promise<MigrationPublishResult> {
  const initial = load(journalPath);
  return await withStoreMutex(initial.pluginsDir, () => {
    const journal = load(journalPath);
    const root = dirname(journalPath);
    const failures: { message: string }[] = [];
    const reports: AgentSyncResult[] = [];
    const stateDecisions: { agent: string; plugin: string }[] = [];
    const record = (op: Operation, result: AgentSyncResult): void => {
      const synchronizing = op.kind === "activate" || op.kind === "refresh";
      reports.push({
        agent: op.agent, skipped: result.skipped,
        affected: synchronizing ? result.affected.filter((name) => name === op.plugin) : [],
        ...(synchronizing && result.verified ? { verified: result.verified.filter((name) => name === op.plugin) } : {}),
        ...(result.unverified ? { unverified: [...result.unverified] } : {}),
        ...(result.failures ? { failures: result.failures.map((failure) => ({ ...failure })) } : {}),
        ...((result.preservedDisabled?.includes(op.plugin) || (op.kind === "disable" && result.affected.includes(op.plugin)))
          ? { preservedDisabled: [op.plugin] } : {}),
      });
    };
    const confirmed = (op: Operation): void => {
      if (op.kind === "retire" || op.notApplicable) return;
      reports.push({ agent: op.agent, affected: [], skipped: false,
        ...(op.desiredEnabled === false || op.kind === "disable" ? { preservedDisabled: [op.plugin] } : { verified: [op.plugin] }) });
    };
    const pending = (op: Operation, message: string, recordFailure = true, skipped = false): void => {
      failures.push({ message });
      for (const report of reports.filter((part) => part.agent === op.agent)) {
        report.affected = report.affected.filter((name) => name !== op.plugin);
        for (const field of ["verified", "preservedDisabled"] as const) {
          if (report[field]) report[field] = report[field]!.filter((name) => name !== op.plugin);
        }
      }
      reports.push({ agent: op.agent, affected: [], skipped, unverified: [op.plugin],
        ...(recordFailure ? { failures: [{ plugin: op.plugin, stage: "verify", errorType: "MIGRATION_NATIVE_PENDING", message }] } : {}) });
    };
    if (journal.complete) {
      cleanupArtifacts(root);
      return { complete: true, journalPath, failures, agents: [], stateDecisions: [] };
    }
    if (options.stateDecisions?.length) {
      applyStateDecisions(journal, options.stateDecisions);
      // Persist the user's choice before invoking any native lifecycle action.
      atomicJson(journalPath, journal);
    }
    const live = readLock(lockPath(journal.pluginsDir));
    for (const name of [...journal.prepared.map((p) => p.name), ...journal.retire, ...(journal.successors ?? []).flatMap((item) => [item.name, ...item.predecessors]), ...(journal.refreshExisting ?? []).map((request) => request.name)]) {
      if (live.plugins[name]) assertSourceOwner(journal.source, journal.ref, live.plugins[name]!);
    }
    if (!journal.published) {
      // Fence older ADG versions before the first runtime-visible payload change.
      atomicJson(lockPath(journal.pluginsDir), { ...live, version: LOCK_VERSION });
      publishPayloads(journal, root);
      publishMetadata(journal, false);
      journal.published = true;
      atomicJson(journalPath, journal);
    }
    for (const op of journal.operations) {
      if (op.done) continue;
      if (op.kind === "retire" && journal.operations.some((o) => o.kind !== "retire" && !o.done)) break;
      const agent = options.targets?.find((t) => t.id === op.agent);
      if (!agent || !agent.available()) {
        pending(op, `Required target ${op.agent} is unavailable; migration remains pending.`, true, true);
        continue;
      }
      try {
        const ctx = { pluginsDir: nativeStore(journal), plugins: [op.plugin], scope: journal.scope, preserveData: true,
          ...(explicitTargetDecision(op, agent.id) === true ? { forceEnable: true } : {}) };
        if (op.kind === "ensure") {
          resolveSuccessorOperation(journal, op, agent);
          atomicJson(journalPath, journal);
          if (op.done) { confirmed(op); continue; }
        }
        if (op.kind === "retire") {
          const required = journal.operations.filter((item) => item.successor);
          let ready = true;
          for (const requirement of required) {
            const provider = options.targets?.find((item) => item.id === requirement.agent);
            if (!provider?.available() || !verifySuccessor(journal, requirement, provider)) {
              requirement.done = false; requirement.started = false; requirement.kind = "ensure";
              pending(requirement, `Successor ${requirement.plugin} is not confirmed in ${requirement.agent}; retirement remains pending.`);
              ready = false;
            }
          }
          if (!ready) { atomicJson(journalPath, journal); break; }
          const observed = agent.inspectPlugins?.(ctx);
          if (Array.isArray(observed) && !observed.some((item) => item.name === op.plugin && item.installed)) {
            op.done = true; atomicJson(journalPath, journal); continue;
          }
        }
        if (op.started) {
          if (proveInterruptedOperation(journal, op, agent)) {
            confirmed(op);
            op.done = true;
            atomicJson(journalPath, journal);
            continue;
          }
          const native = agent.inspectPlugins?.(ctx);
          if (Array.isArray(native) && native.some((p) => p.name === op.plugin && p.installed && !p.enabled)
              && op.kind !== "retire" && op.kind !== "disable" && explicitTargetDecision(op, agent.id) !== true) {
            op.desiredEnabled = false;
            confirmed(op);
            op.done = true;
            atomicJson(journalPath, journal);
            continue;
          }
          if (op.kind === "activate" && explicitTargetDecision(op, agent.id) === true
              && Array.isArray(native) && native.some((item) => item.name === op.plugin && item.installed && !item.enabled)
              && agent.retrySafeOperations?.includes("refresh")) {
            // Installation may have committed before explicit enablement. Use
            // the adapter's declared safe refresh instead of replaying activate.
            op.kind = "refresh";
            atomicJson(journalPath, journal);
          }
          const retryKind = op.kind === "retire" || op.kind === "disable" ? "deactivate" : op.kind === "ensure" ? "refresh" : op.kind;
          if (retryKind !== "deactivate" && agent.retrySafeOperations?.includes(retryKind) && !Array.isArray(native)) {
            pending(op, `${op.agent} could not inspect disabled state before retrying ${op.plugin}; repair native plugin listing and rerun the same ADG update.`);
            continue;
          }
          if (!agent.retrySafeOperations?.includes(retryKind)) {
            if ((op.kind === "activate" || op.kind === "refresh") && Array.isArray(native) && !native.some((p) => p.name === op.plugin && p.installed)) {
              op.kind = "activate";
            } else {
              const remediation = agent.inspectPlugins
                ? `Remove this plugin from the ${op.agent} runtime using its native plugin manager (keep user data), then rerun the same ADG update; ADG will reinstall the durable prepared snapshot.`
                : "This adapter must implement native readback or declare safe idempotent retry before ADG can resume; keep the pending journal and update the adapter, then rerun the same ADG update.";
              pending(op, `${op.agent} ${op.kind} ${op.plugin} was interrupted; native state cannot prove completion. ${remediation}`);
              continue;
            }
          }
          op.started = false;
          atomicJson(journalPath, journal);
        }
        op.started = true;
        atomicJson(journalPath, journal);
        const result = op.kind === "activate" ? agent.activate(ctx)
          : op.kind === "refresh" ? agent.refresh(ctx) : agent.deactivate(ctx);
        record(op, result);
        if (result.preservedDisabled?.includes(op.plugin)) {
          if (explicitTargetDecision(op, agent.id) === true) {
            op.started = false;
            atomicJson(journalPath, journal);
            pending(op, `${op.agent} preserved disabled state for ${op.plugin} despite the explicit enable decision; native enablement remains pending.`);
            continue;
          }
          op.desiredEnabled = false;
          op.done = true;
          atomicJson(journalPath, journal);
          continue;
        }
        if (result.skipped || result.failures?.length || !result.affected.includes(op.plugin)) {
          op.started = false;
          atomicJson(journalPath, journal);
          pending(op, `${op.agent} ${op.kind} ${op.plugin}: ${result.failures?.map((f) => f.message).join("; ") || "operation not confirmed"}`, !result.failures?.length);
          continue;
        }
        if (result.unverified?.includes(op.plugin)) {
          pending(op, `${op.agent} did not verify ${op.plugin}`);
          continue;
        }
        const installed = agent.listInstalled?.(ctx);
        if (installed !== undefined && (!Array.isArray(installed)
            || (op.kind === "retire" || op.kind === "disable" ? installed.includes(op.plugin) : !installed.includes(op.plugin)))) {
          pending(op, `${op.agent} could not verify ${op.kind} ${op.plugin}`);
          continue;
        }
        if (!verifySuccessor(journal, op, agent)) {
          pending(op, `${op.agent} could not verify successor ${op.plugin}; retirement remains pending.`);
          continue;
        }
        if ((op.kind === "activate" || op.kind === "refresh") && (Array.isArray(installed) || op.successor)) {
          reports.push({ agent: op.agent, affected: [], verified: [op.plugin], skipped: false });
        }
        op.done = true;
        atomicJson(journalPath, journal);
      } catch (error) {
        if (error instanceof NativeStateDecisionRequired && !stateDecisions.some((item) => item.agent === error.agent && item.plugin === error.plugin)) {
          stateDecisions.push({ agent: error.agent, plugin: error.plugin });
        }
        pending(op, `${op.agent} ${op.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (journal.operations.every((op) => op.done)) {
      publishMetadata(journal, true);
      for (const name of journal.retire) {
        const entry = journal.before.plugins[name];
        if (entry) {
          const path = installedPluginDir(journal.pluginsDir, name, entry.origin);
          rmSync(path, { recursive: true, force: true });
          if (existsSync(dirname(path))) syncPath(dirname(path));
        }
        for (const store of cacheStores(journal)) {
          const cache = pluginSourceCacheDir(store, name);
          rmSync(cache, { recursive: true, force: true });
          if (existsSync(dirname(cache))) syncPath(dirname(cache));
        }
      }
      journal.complete = true;
      atomicJson(journalPath, journal);
      cleanupArtifacts(root);
    }
    recordTelemetryEvent("adg.migration.publish", { "migration.complete": journal.complete, "failure.count": failures.length });
    return { complete: journal.complete, journalPath, failures, agents: mergeAgentReports(reports), stateDecisions };
  });
}
