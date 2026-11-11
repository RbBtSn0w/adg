import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentProcessIdentity, queryProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { recordTelemetryEvent } from "./telemetry.ts";

const ownership = new AsyncLocalStorage<boolean>();
const defaultMutexDir = join(tmpdir(), `adg-mutation-${process.getuid?.() ?? "user"}.lock`);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function ownerIdentity(path: string, pid: number): ProcessIdentity | undefined {
  let raw: string;
  try { raw = readFileSync(join(path, "owner.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // Legacy contender.
    throw error;
  }
  try {
    const owner = JSON.parse(raw);
    if (owner?.version !== 1 || owner.pid !== pid || owner.identity?.version !== 1
      || typeof owner.identity.kind !== "string" || !owner.identity.kind
      || typeof owner.identity.birthToken !== "string" || !owner.identity.birthToken) throw new Error();
    return owner.identity;
  } catch { throw new Error("Invalid ADG mutation owner record; inspect stale mutex records before retrying."); }
}

interface Contender { id: string; pid: number; identity?: ProcessIdentity; ticket?: number; unreadable?: boolean }

function transientWindowsAccess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

function contenderPresence(path: string): "present" | "absent" | "unknown" {
  try { lstatSync(path); return "present"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    // Windows delete-pending records can deny both reads and metadata access.
    // Uncertain presence must block; existsSync would incorrectly report false.
    if (transientWindowsAccess(error)) return "unknown";
    throw error;
  }
}

function contenders(root: string): Contender[] {
  return readdirSync(root).flatMap<Contender>((id) => {
    const match = id.match(/^(\d+)-[a-f0-9-]{36}$/);
    if (!match) return [];
    const path = join(root, id);
    // Names are unique for the life of a contender. Reaping this path can never
    // unlink the record of a replacement holder, unlike a shared lock filename.
    if (!alive(Number(match[1]))) {
      rmSync(path, { recursive: true, force: true });
      recordTelemetryEvent("adg.store.mutex.reclaimed", { reason: "process_exit" });
      return [];
    }
    const pid = Number(match[1]);
    let identity: ProcessIdentity | undefined;
    try { identity = ownerIdentity(path, pid); }
    catch (error) {
      if (transientWindowsAccess(error)) return [{ id, pid, unreadable: true }];
      throw error;
    }
    try {
      const ticket: unknown = JSON.parse(readFileSync(join(path, "ticket.json"), "utf8"));
      if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket <= 0) {
        throw new Error("Invalid ADG mutation ticket");
      }
      return [{ id, pid, identity, ticket }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || transientWindowsAccess(error)) {
        const presence = contenderPresence(path);
        if (presence === "absent") return [];
        // Only ENOENT with confirmed directory presence proves the choosing
        // phase. An unreadable published ticket may belong to an active holder.
        return [{ id, pid, identity, unreadable: transientWindowsAccess(error) || presence === "unknown" }];
      }
      throw error;
    }
  });
}

/** Serialize stores and shared native state using Lamport's bakery algorithm.
 * Every contender publishes an immutable ticket atomically. A dead process is
 * reclaimed by its unique name, including crashes before ticket publication.
 * Nested helpers share ownership; invoke internal helpers instead of child ADG
 * mutators while holding the mutex.
 */
export async function withStoreMutex<T>(
  _pluginsDir: string, action: () => T | Promise<T>, timeoutMs = 30_000,
): Promise<T> {
  if (ownership.getStore()) return await action();
  const root = process.env.ADG_MUTEX_HOME || defaultMutexDir;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077))) {
    throw new Error("ADG mutation mutex must be a private directory owned by the current user");
  }
  const id = `${process.pid}-${randomUUID()}`;
  const path = join(root, id);
  const identity = getCurrentProcessIdentity();
  const staging = join(root, `.preparing-${id}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeFileSync(join(staging, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, identity }), { mode: 0o600 });
    // Publish a complete owner atomically; old clients still recognize pid-UUID.
    renameSync(staging, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const started = Date.now();
  // OS birth queries can launch PowerShell. Only actual blockers need them;
  // a stale high ticket merely overestimates our ticket and remains safe.
  const checked = new Map<string, number>();
  const reclaimReusedBlocker = (other: Contender): boolean => {
    if (!other.identity || other.id === id) return false;
    const last = checked.get(other.id);
    if (last !== undefined && Date.now() - last < 1000) return false;
    const current = queryProcessIdentity(other.pid);
    checked.set(other.id, Date.now());
    if (!current || other.identity.kind !== current.kind || other.identity.version !== current.version
      || other.identity.birthToken === current.birthToken) return false;
    rmSync(join(root, other.id), { recursive: true, force: true });
    recordTelemetryEvent("adg.store.mutex.reclaimed", { reason: "process_identity_changed" });
    return true;
  };
  const wait = async () => {
    if (Date.now() - started >= timeoutMs) throw new Error("Another ADG mutation is still running; retry after it completes.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  };
  try {
    let snapshot = contenders(root);
    // Do not choose a smaller ticket while a holder's published ticket might be
    // hidden. Genuine choosing contenders stay eligible to choose concurrently.
    while (snapshot.some(entry => entry.unreadable && !reclaimReusedBlocker(entry))) {
      await wait();
      snapshot = contenders(root);
    }
    const ticket = 1 + Math.max(0, ...snapshot.map((entry) => entry.ticket ?? 0));
    writeFileSync(join(path, "ticket.tmp"), JSON.stringify(ticket), { mode: 0o600 });
    renameSync(join(path, "ticket.tmp"), join(path, "ticket.json"));
    for (;;) {
      const earlier = contenders(root).some((other) => other.id !== id && (other.ticket === undefined
        || other.ticket < ticket || (other.ticket === ticket && other.id < id)) && !reclaimReusedBlocker(other));
      if (!earlier) break;
      await wait();
    }
    recordTelemetryEvent("adg.store.mutex.acquired", { "wait.ms": Date.now() - started });
    return await ownership.run(true, action);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
