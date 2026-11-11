import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTelemetryEvent } from "./telemetry.ts";

const ownership = new AsyncLocalStorage<boolean>();
const defaultMutexDir = join(tmpdir(), `adg-mutation-${process.getuid?.() ?? "user"}.lock`);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

interface Contender { id: string; ticket?: number }

function contenders(root: string): Contender[] {
  return readdirSync(root).flatMap((id) => {
    const match = id.match(/^(\d+)-[a-f0-9-]{36}$/);
    if (!match) return [];
    const path = join(root, id);
    // Names are unique for the life of a contender. Reaping this path can never
    // unlink the record of a replacement holder, unlike a shared lock filename.
    if (!alive(Number(match[1]))) {
      rmSync(path, { recursive: true, force: true });
      return [];
    }
    try {
      const ticket: unknown = JSON.parse(readFileSync(join(path, "ticket.json"), "utf8"));
      if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket <= 0) {
        throw new Error("Invalid ADG mutation ticket");
      }
      return [{ id, ticket }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Missing ticket is the choosing phase; the owner may still publish it.
        return existsSync(path) ? [{ id }] : [];
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
  mkdirSync(path, { mode: 0o700 });
  const started = Date.now();
  try {
    const ticket = 1 + Math.max(0, ...contenders(root).map((entry) => entry.ticket ?? 0));
    writeFileSync(join(path, "ticket.tmp"), JSON.stringify(ticket), { mode: 0o600 });
    renameSync(join(path, "ticket.tmp"), join(path, "ticket.json"));
    for (;;) {
      const earlier = contenders(root).some((other) => other.id !== id && (other.ticket === undefined
        || other.ticket < ticket || (other.ticket === ticket && other.id < id)));
      if (!earlier) break;
      if (Date.now() - started >= timeoutMs) throw new Error("Another ADG mutation is still running; retry after it completes.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    recordTelemetryEvent("adg.store.mutex.acquired", { "wait.ms": Date.now() - started });
    return await ownership.run(true, action);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
