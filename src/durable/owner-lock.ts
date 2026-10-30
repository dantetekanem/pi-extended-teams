import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;

export class DurableRuntimeBusyError extends Error {
  constructor(file: string, options?: ErrorOptions) {
    super(`Another process already owns the durable agent runtime at ${file}.`, options);
    this.name = "DurableRuntimeBusyError";
  }
}

export interface OwnerLock {
  release(): void;
}

/**
 * Pi Durable storage has no cross-process locking. An exclusive SQLite lock keeps a second process out, and the
 * kernel drops it when the owning process dies, so a crash never leaves a stale lock behind.
 *
 * The lock is a POSIX advisory lock: it is also dropped when anything else in this process opens and closes the
 * lock file, so nothing may touch that file while the lock is held.
 */
export function acquireOwnerLock(file: string): OwnerLock {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) throw new DurableRuntimeBusyError(file, { cause: error });
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      database.close();
    },
  };
}
