import { describe, expect, it, vi } from "vitest";
import {
  createActiveAgentSleepController,
  runWithActiveAgentSleepAssertion,
} from "./active-agent-sleep.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeChild() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    kill: vi.fn(() => true),
    unref: vi.fn(),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return child;
    }),
  };
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
  };
}

function darwinController() {
  const process = fakeChild();
  const spawnProcess = vi.fn(() => process.child);
  const controller = createActiveAgentSleepController({
    platform: "darwin",
    pid: 4242,
    executable: "/usr/bin/caffeinate",
    executableExists: vi.fn(() => true),
    spawnProcess,
  });
  return { controller, process, spawnProcess };
}

describe("active agent sleep controller", () => {
  it("shares one idle-sleep assertion until the final concurrent agent releases it", () => {
    const { controller, process, spawnProcess } = darwinController();

    const releaseFirst = controller.retain();
    const releaseSecond = controller.retain();

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-i", "-w", "4242"],
      { stdio: "ignore" },
    );
    expect(process.child.unref).toHaveBeenCalledOnce();

    releaseFirst();
    expect(process.child.kill).not.toHaveBeenCalled();

    releaseSecond();
    releaseSecond();
    expect(process.child.kill).toHaveBeenCalledOnce();
    expect(process.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    { name: "non-macOS", platform: "linux", executableExists: true },
    { name: "missing caffeinate", platform: "darwin", executableExists: false },
  ])("is a safe no-op on $name", ({ platform, executableExists }) => {
    const spawnProcess = vi.fn();
    const controller = createActiveAgentSleepController({
      platform,
      pid: 4242,
      executable: "/usr/bin/caffeinate",
      executableExists: vi.fn(() => executableExists),
      spawnProcess,
    });

    const release = controller.retain();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
  });

  it("falls back without failing the agent when caffeinate cannot be spawned", () => {
    const spawnProcess = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const controller = createActiveAgentSleepController({
      platform: "darwin",
      pid: 4242,
      executable: "/usr/bin/caffeinate",
      executableExists: vi.fn(() => true),
      spawnProcess,
    });

    const release = controller.retain();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(() => release()).not.toThrow();
  });

  it("keeps the shared assertion until all wrapped agent runs settle", async () => {
    const { controller, process, spawnProcess } = darwinController();
    const first = deferred<void>();
    const second = deferred<void>();

    const firstRun = runWithActiveAgentSleepAssertion(controller, () => first.promise);
    const secondRun = runWithActiveAgentSleepAssertion(controller, () => second.promise);

    expect(spawnProcess).toHaveBeenCalledOnce();
    first.resolve();
    await firstRun;
    expect(process.child.kill).not.toHaveBeenCalled();

    second.resolve();
    await secondRun;
    expect(process.child.kill).toHaveBeenCalledOnce();
  });

  it("releases the assertion after synchronous launch failure and async rejection", async () => {
    const releaseSync = vi.fn();
    const releaseAsync = vi.fn();
    const controller = {
      retain: vi.fn()
        .mockReturnValueOnce(releaseSync)
        .mockReturnValueOnce(releaseAsync),
      dispose: vi.fn(),
    };

    expect(() => runWithActiveAgentSleepAssertion(controller, () => {
      throw new Error("sync failure");
    })).toThrow("sync failure");
    expect(releaseSync).toHaveBeenCalledOnce();

    await expect(runWithActiveAgentSleepAssertion(controller, async () => {
      throw new Error("async failure");
    })).rejects.toThrow("async failure");
    expect(releaseAsync).toHaveBeenCalledOnce();
  });

  it("force-releases the assertion during extension disposal", () => {
    const { controller, process } = darwinController();
    const release = controller.retain();

    controller.dispose();
    release();

    expect(process.child.kill).toHaveBeenCalledOnce();
    expect(process.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
