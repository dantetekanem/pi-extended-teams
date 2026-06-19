// Project: pi-extended-teams
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LOCK_TIMEOUT = 30000; // 30 seconds of retrying under high fan-out contention
const LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_RETRIES = Math.ceil(LOCK_TIMEOUT / LOCK_RETRY_DELAY_MS);
const STALE_LOCK_TIMEOUT = 30000; // 30 seconds for a lock to be considered stale
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
    const age = Date.now() - stats.mtimeMs;
    if (age <= STALE_LOCK_TIMEOUT) return;
    fs.unlinkSync(lockFile);
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
