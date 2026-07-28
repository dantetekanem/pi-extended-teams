import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withLock } from "./lock";

describe("withLock race conditions", () => {
  const testDir = path.join(os.tmpdir(), "pi-lock-race-test-" + Date.now());
  const lockPath = path.join(testDir, "test");
  const lockFile = `${lockPath}.lock`;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should handle multiple concurrent attempts to acquire the lock", async () => {
    let counter = 0;
    const iterations = 20;
    const concurrentCount = 5;

    const runTask = async () => {
      for (let i = 0; i < iterations; i++) {
        await withLock(lockPath, async () => {
          const current = counter;
          // Add a small delay to increase the chance of race conditions if locking fails
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          counter = current + 1;
        });
      }
    };

    const promises = [];
    for (let i = 0; i < concurrentCount; i++) {
      promises.push(runTask());
    }

    await Promise.all(promises);

    expect(counter).toBe(iterations * concurrentCount);
  });

  it("keeps mutual exclusion when two contenders reap the same stale lock", async () => {
    // Models the cross-process interleaving: each contender's first stat of the
    // lock observes the original stale lock, as if it ran before the other
    // contender reaped and re-created it. Everything else is the real code path.
    const dataPath = path.join(testDir, "stale-reap.json");
    fs.writeFileSync(dataPath, JSON.stringify({ counter: 0 }));
    const staleLockFile = `${dataPath}.lock`;
    fs.writeFileSync(staleLockFile, JSON.stringify({ pid: 99999, token: "dead", acquiredAt: 1 }));
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(staleLockFile, longAgo, longAgo);

    const realStatSync = fs.statSync;
    let staleStatsServed = 0;
    vi.spyOn(fs, "statSync").mockImplementation(((target: any, ...rest: any[]) => {
      if (target === staleLockFile && staleStatsServed < 2) {
        staleStatsServed++;
        const real = realStatSync(staleLockFile);
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { mtimeMs: Date.now() - 60_000 });
      }
      return (realStatSync as any)(target, ...rest);
    }) as typeof fs.statSync);

    let concurrent = 0;
    let maxConcurrent = 0;
    const readModifyWrite = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const value = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      await new Promise(resolve => setTimeout(resolve, 50));
      fs.writeFileSync(dataPath, JSON.stringify({ counter: value.counter + 1 }));
      concurrent--;
    };

    const first = withLock(dataPath, readModifyWrite);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = withLock(dataPath, readModifyWrite);
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(JSON.parse(fs.readFileSync(dataPath, "utf-8")).counter).toBe(2);
  });

  it("reaps a stale lock again after a previous reaper crashed holding the guard", async () => {
    const dataPath = path.join(testDir, "crashed-guard.json");
    const staleLockFile = `${dataPath}.lock`;
    fs.writeFileSync(staleLockFile, JSON.stringify({ pid: 99999, token: "dead", acquiredAt: 1 }));
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(staleLockFile, longAgo, longAgo);
    // Guard left behind by a reaper that died mid-reap.
    fs.writeFileSync(`${staleLockFile}.reap`, "99999");
    fs.utimesSync(`${staleLockFile}.reap`, longAgo, longAgo);

    await expect(withLock(dataPath, async () => "ran", 200)).resolves.toBe("ran");
    expect(fs.existsSync(`${staleLockFile}.reap`)).toBe(false);
  });
});
