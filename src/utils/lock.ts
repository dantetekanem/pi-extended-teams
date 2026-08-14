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
    if (
      parsed
      && Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && typeof parsed.acquiredAt === "number"
    ) return parsed;
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      // PID reuse can delay reclaiming a legacy lock, but the liveness check
      // below will never revoke it while any process has that PID.
      return { pid: parsed, token: `legacy-pid:${parsed}`, acquiredAt: 0 };
    }
  } catch {
    // Malformed owner records cannot be reclaimed without positive evidence.
  }
  return null;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Only ESRCH is
    // positive evidence that a local process no longer exists.
    return errorCode(error) === "ESRCH";
  }
}

function publishReapGuard(guardFile: string, owner: LockOwner): boolean {
  const candidateName = `.candidate-${crypto.createHash("sha256").update(owner.token).digest("hex")}`;
  const candidate = path.join(path.dirname(guardFile), candidateName);

  try {
    try {
      fs.writeFileSync(candidate, JSON.stringify(owner), { flag: "wx" });
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || readLockOwner(candidate)?.token !== owner.token) return false;
    }

    // The complete candidate is published with a no-clobber hard link. A
    // process dying before this point leaves no visible epoch; dying after it
    // leaves a complete owner record that a later epoch can recover from.
    fs.linkSync(candidate, guardFile);
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (readLockOwner(candidate)?.token === owner.token) fs.unlinkSync(candidate);
    } catch {
      // The candidate is unique to this owner and may already be gone.
    }
  }
}

function acquireReapGuard(lockFile: string, staleOwner: LockOwner, reaper: LockOwner): boolean {
  const guardDir = `${lockFile}.reap`;
  try {
    fs.mkdirSync(guardDir, { recursive: true });
  } catch {
    return false;
  }

  const generation = crypto.createHash("sha256").update(staleOwner.token).digest("hex");
  for (let epoch = 0; ; epoch++) {
    const guardFile = path.join(guardDir, `${generation}.${epoch}`);
    if (publishReapGuard(guardFile, reaper)) return true;

    const guardOwner = readLockOwner(guardFile);
    if (guardOwner?.token === reaper.token) return true;
    if (!guardOwner || !processIsDefinitelyDead(guardOwner.pid)) return false;
    // Guard epochs are immutable and never unlinked. After a proven owner
    // death, contenders race to publish the next epoch instead of replacing
    // state that another live contender may already own.
  }
}

function removeStaleLock(lockFile: string, reaper: LockOwner): void {
  try {
    const staleOwner = readLockOwner(lockFile);
    if (!staleOwner) return;
    if (Date.now() - fs.statSync(lockFile).mtimeMs <= STALE_LOCK_TIMEOUT) return;
    if (!processIsDefinitelyDead(staleOwner.pid)) return;
    if (!acquireReapGuard(lockFile, staleOwner, reaper)) return;

    // Re-check both generation and liveness while holding the generation's
    // immutable guard. No other live reaper for this generation can reach the
    // unlink, so the path cannot be replaced between this check and removal.
    const currentOwner = readLockOwner(lockFile);
    if (currentOwner?.token !== staleOwner.token) return;
    if (Date.now() - fs.statSync(lockFile).mtimeMs <= STALE_LOCK_TIMEOUT) return;
    if (!processIsDefinitelyDead(currentOwner.pid)) return;
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
      removeStaleLock(lockFile, owner);
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
