// Project: pi-extended-teams
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT = 30000; // 30 seconds of retrying under high fan-out contention
const LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_RETRIES = Math.ceil(LOCK_TIMEOUT / LOCK_RETRY_DELAY_MS);
const STALE_LOCK_TIMEOUT = 30000; // 30 seconds for a lock to be considered stale
const REAP_GUARD_STALE_MS = 5000; // a reap guard older than this belongs to a crashed reaper
const LOCK_HEARTBEAT_INTERVAL_MS = Math.max(1000, Math.floor(STALE_LOCK_TIMEOUT / 3));

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: number;
}

function readLockOwner(lockFile: string): LockOwner | null {
  try {
    const raw = fs.readFileSync(lockFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string") return parsed;
  } catch {
    // Older lock files were just a pid string; treat them as unowned for release safety.
  }
  return null;
}

function removeStaleLock(lockFile: string): void {
  try {
    const stats = fs.statSync(lockFile);
    if (Date.now() - stats.mtimeMs <= STALE_LOCK_TIMEOUT) return;
    // Serialize reaping. Without this, a contender that statted the stale lock
    // and was then preempted could unlink a fresh lock another contender just
    // created, letting two holders into the critical section at once.
    const guard = `${lockFile}.reap`;
    try {
      fs.writeFileSync(guard, String(process.pid), { flag: "wx" });
    } catch {
      // Another contender holds the reap guard, or a crashed reaper left one
      // behind. Clear crashed guards so reaping cannot wedge permanently.
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > REAP_GUARD_STALE_MS) fs.unlinkSync(guard);
      } catch {
        // Guard already gone; the active reaper finished.
      }
      return; // Retry on the next acquire iteration.
    }
    try {
      // Re-check under the guard: only unlink if the lock is still stale. A
      // fresh file here means another contender already reaped and re-acquired.
      if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_TIMEOUT) {
        fs.unlinkSync(lockFile);
      }
    } finally {
      fs.unlinkSync(guard);
    }
  } catch {
    // Ignore: another process may have removed it, or it may not exist yet.
  }
}

function touchOwnedLock(lockFile: string, token: string): void {
  const owner = readLockOwner(lockFile);
  if (owner?.token !== token) return;
  try {
    const now = new Date();
    fs.utimesSync(lockFile, now, now);
  } catch {
    // Ignore: another process may have removed it after the ownership check.
  }
}

function releaseOwnedLock(lockFile: string, token: string): void {
  const owner = readLockOwner(lockFile);
  if (owner?.token !== token) return;
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Ignore: another process may have removed it after the ownership check.
  }
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, retries: number = DEFAULT_LOCK_RETRIES): Promise<T> {
  const lockFile = `${lockPath}.lock`;
  const lockDir = path.dirname(lockFile);
  const owner: LockOwner = {
    pid: process.pid,
    token: `${process.pid}:${Date.now()}:${crypto.randomUUID()}`,
    acquiredAt: Date.now(),
  };

  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

  let remainingRetries = retries;
  let acquired = false;
  while (remainingRetries > 0) {
    try {
      removeStaleLock(lockFile);
      fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: "wx" });
      acquired = true;
      break;
    } catch {
      remainingRetries--;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }

  if (!acquired) {
    throw new Error("Could not acquire lock");
  }

  const heartbeat = setInterval(() => touchOwnedLock(lockFile, owner.token), LOCK_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseOwnedLock(lockFile, owner.token);
  }
}
