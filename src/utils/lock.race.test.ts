import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withLock } from "./lock";

interface ReaperChild {
  child: ChildProcess;
  gateDir: string;
  stderr: () => string;
}

function waitForAnyFile(files: string[], timeoutMs = 10_000): Promise<string> {
  const existing = files.find(file => fs.existsSync(file));
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const watchers: fs.FSWatcher[] = [];
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${files.join(" or ")}`)), timeoutMs);

    const finish = (error?: Error, file?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const watcher of watchers) watcher.close();
      if (error) reject(error);
      else resolve(file!);
    };

    const check = () => {
      const file = files.find(candidate => fs.existsSync(candidate));
      if (file) finish(undefined, file);
    };

    for (const directory of new Set(files.map(file => path.dirname(file)))) {
      watchers.push(fs.watch(directory, check));
    }
    check();
  });
}

function waitForFile(file: string): Promise<string> {
  return waitForAnyFile([file]);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function getExitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) throw new Error("Child process did not expose a pid");
  await waitForExit(child);
  return pid;
}

function readResult(gateDir: string): { status: string; message?: string; pid?: number } {
  return JSON.parse(fs.readFileSync(path.join(gateDir, "result.json"), "utf-8"));
}

describe("withLock race conditions", () => {
  const testDir = path.join(os.tmpdir(), "pi-lock-race-test-" + Date.now());
  const lockPath = path.join(testDir, "test");
  const lockFile = `${lockPath}.lock`;
  const children: ReaperChild[] = [];

  function startReaper(name: string, options: { pauseBeforeReap: boolean; holdCallback: boolean; retries: number }): ReaperChild {
    const gateDir = path.join(testDir, name);
    fs.mkdirSync(gateDir, { recursive: true });
    const fixture = path.join(__dirname, "lock.race.child.ts");
    const child = spawn(process.execPath, [
      "-r",
      "ts-node/register",
      fixture,
      lockPath,
      gateDir,
      String(options.pauseBeforeReap),
      String(options.holdCallback),
      String(options.retries),
    ], {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    const running = { child, gateDir, stderr: () => stderr };
    children.push(running);
    return running;
  }

  function release(child: ReaperChild, gate: "before-reap" | "callback"): void {
    fs.writeFileSync(path.join(child.gateDir, `${gate}.release`), "");
  }

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    for (const running of children) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    }
    await Promise.all(children.map(running => waitForExit(running.child).catch(() => undefined)));
    children.length = 0;
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
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          counter = current + 1;
        });
      }
    };

    await Promise.all(Array.from({ length: concurrentCount }, runTask));

    expect(counter).toBe(iterations * concurrentCount);
  });

  it("does not revoke a live paused reaper or let it delete a successor lock", async () => {
    const deadOwnerPid = await getExitedPid();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadOwnerPid, token: "dead-lock", acquiredAt: 1 }));
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, longAgo, longAgo);

    const first = startReaper("first", { pauseBeforeReap: true, holdCallback: true, retries: 20 });
    await waitForFile(path.join(first.gateDir, "before-reap.ready"));

    const reapGuard = `${lockFile}.reap`;
    fs.utimesSync(reapGuard, longAgo, longAgo);

    const second = startReaper("second", { pauseBeforeReap: true, holdCallback: true, retries: 10 });
    const secondBeforeReap = path.join(second.gateDir, "before-reap.ready");
    const secondResult = path.join(second.gateDir, "result.json");
    const secondOutcome = await waitForAnyFile([secondBeforeReap, secondResult]);

    let callbacksOverlapped = false;
    if (secondOutcome === secondBeforeReap) {
      release(first, "before-reap");
      await waitForFile(path.join(first.gateDir, "callback.ready"));
      release(second, "before-reap");
      await waitForFile(path.join(second.gateDir, "callback.ready"));
      callbacksOverlapped = true;
      release(first, "callback");
      release(second, "callback");
      await Promise.all([
        waitForFile(path.join(first.gateDir, "result.json")),
        waitForFile(path.join(second.gateDir, "result.json")),
      ]);
    } else {
      expect(readResult(second.gateDir)).toMatchObject({ status: "error", message: "Could not acquire lock" });
      release(first, "before-reap");
      await waitForFile(path.join(first.gateDir, "callback.ready"));
      release(first, "callback");
      await waitForFile(path.join(first.gateDir, "result.json"));
      expect(readResult(first.gateDir)).toMatchObject({ status: "success" });
    }

    expect(callbacksOverlapped).toBe(false);
    expect(first.stderr()).toBe("");
    expect(second.stderr()).toBe("");
  }, 20_000);

  it("recovers after a reaper genuinely dies while holding the guard", async () => {
    const deadOwnerPid = await getExitedPid();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadOwnerPid, token: "dead-lock", acquiredAt: 1 }));
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, longAgo, longAgo);

    const crashed = startReaper("crashed", { pauseBeforeReap: true, holdCallback: false, retries: 20 });
    await waitForFile(path.join(crashed.gateDir, "before-reap.ready"));
    crashed.child.kill("SIGKILL");
    await waitForExit(crashed.child);
    fs.utimesSync(`${lockFile}.reap`, longAgo, longAgo);

    const recovery = startReaper("recovery", { pauseBeforeReap: false, holdCallback: false, retries: 200 });
    await waitForFile(path.join(recovery.gateDir, "result.json"));

    expect(readResult(recovery.gateDir)).toMatchObject({ status: "success" });
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(recovery.stderr()).toBe("");
  }, 20_000);
});
