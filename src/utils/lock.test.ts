// Project: pi-extended-teams
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withLock } from "./lock";

describe("withLock", () => {
  const testDir = path.join(os.tmpdir(), "pi-lock-test-" + Date.now());
  const lockPath = path.join(testDir, "test");
  const lockFile = `${lockPath}.lock`;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should successfully acquire and release the lock", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const result = await withLock(lockPath, fn);

    expect(result).toBe("result");
    expect(fn).toHaveBeenCalled();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("should fail to acquire lock if already held", async () => {
    // Manually create lock file
    fs.writeFileSync(lockFile, "9999");

    const fn = vi.fn().mockResolvedValue("result");
    
    // Test with only 2 retries to speed up the failure
    await expect(withLock(lockPath, fn, 2)).rejects.toThrow("Could not acquire lock");
    expect(fn).not.toHaveBeenCalled();
  });

  it("should release lock even if function fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("failure"));

    await expect(withLock(lockPath, fn)).rejects.toThrow("failure");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("removes stale lock files before acquiring", async () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 9999, token: "stale", acquiredAt: 1 }));
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, staleTime, staleTime);

    const fn = vi.fn().mockResolvedValue("result");
    await expect(withLock(lockPath, fn)).resolves.toBe("result");
    expect(fn).toHaveBeenCalled();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("heartbeats held locks so long critical sections do not become stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-19T12:00:00.000Z"));
    let release!: () => void;

    const running = withLock(lockPath, async () => new Promise<string>((resolve) => {
      release = () => resolve("done");
    }));
    await vi.advanceTimersByTimeAsync(0);

    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, staleTime, staleTime);
    const initialMtime = fs.statSync(lockFile).mtimeMs;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(fs.statSync(lockFile).mtimeMs).toBeGreaterThan(initialMtime);

    release();
    await expect(running).resolves.toBe("done");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("does not remove a lock now owned by another holder", async () => {
    await withLock(lockPath, async () => {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 1234, token: "other-owner", acquiredAt: Date.now() }));
    });

    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, "utf-8"))).toMatchObject({ token: "other-owner" });
  });
});
