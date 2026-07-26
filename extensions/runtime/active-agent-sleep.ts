import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const MACOS_CAFFEINATE = "/usr/bin/caffeinate";
const NOOP_RELEASE = () => {};

export interface SleepAssertionProcess {
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
  once(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ActiveAgentSleepController {
  retain(): () => void;
  dispose(): void;
}

export interface ActiveAgentSleepControllerOptions {
  platform?: string;
  pid?: number;
  executable?: string;
  executableExists?(path: string): boolean;
  spawnProcess?(
    command: string,
    args: string[],
    options: { stdio: "ignore" },
  ): SleepAssertionProcess;
}

export function createActiveAgentSleepController(
  options: ActiveAgentSleepControllerOptions = {},
): ActiveAgentSleepController {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const executable = options.executable ?? MACOS_CAFFEINATE;
  const executableExists = options.executableExists ?? existsSync;
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => {
    return spawn(command, args, spawnOptions);
  });

  let activeCount = 0;
  let disposed = false;
  let assertionProcess: SleepAssertionProcess | null = null;

  const stopAssertion = () => {
    const child = assertionProcess;
    assertionProcess = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The assertion may already have exited. Releasing remains idempotent.
    }
  };

  const startAssertion = () => {
    if (platform !== "darwin" || !executableExists(executable) || assertionProcess) return;

    let child: SleepAssertionProcess | null = null;
    try {
      // -i prevents only idle system sleep. Omitting -d/-u intentionally allows
      // the display to dim and sleep. -w also releases if the lead Pi exits.
      child = spawnProcess(executable, ["-i", "-w", String(pid)], { stdio: "ignore" });
      assertionProcess = child;
      child.once("error", () => {
        if (assertionProcess === child) assertionProcess = null;
      });
      child.once("exit", () => {
        if (assertionProcess === child) assertionProcess = null;
      });
      child.unref();
    } catch {
      if (assertionProcess === child) assertionProcess = null;
      try {
        child?.kill("SIGTERM");
      } catch {
        // Missing/unlaunchable caffeinate is a portable best-effort no-op.
      }
    }
  };

  return {
    retain() {
      if (disposed) return NOOP_RELEASE;
      activeCount += 1;
      if (activeCount === 1) startAssertion();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (disposed) return;
        activeCount = Math.max(0, activeCount - 1);
        if (activeCount === 0) stopAssertion();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeCount = 0;
      stopAssertion();
    },
  };
}

export function runWithActiveAgentSleepAssertion<T>(
  controller: ActiveAgentSleepController,
  launch: () => T | PromiseLike<T>,
): Promise<Awaited<T>> {
  const release = controller.retain();
  try {
    return Promise.resolve(launch()).finally(release);
  } catch (error) {
    release();
    throw error;
  }
}
