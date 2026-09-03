import { describe, expect, it, vi } from "vitest";
import type { RunningReadAgent } from "./types";
import { createAgentFollowComponent } from "../ui/agent-follow-view";
import {
  createHerdrPaneController,
  performReadAgentHerdrHandoff,
  waitForExternalAgentReady,
  waitForReadAgentDetach,
} from "./herdr-handoff";

describe("Herdr agent handoff pane controller", () => {
  it("creates a focused sibling pane with the existing team identity and resumes Pi there", () => {
    const run = vi.fn((command: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "split") {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "" };
    });
    const controller = createHerdrPaneController({
      env: {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      },
      run,
    });

    expect(controller.isAvailable()).toBe(true);
    const paneId = controller.createAgentPane({
      cwd: "/tmp/project",
      teamName: "session-team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      processIdentity: "handoff-token-1",
    });
    controller.startAgent(paneId, "pi --session '/tmp/child session.jsonl'");

    expect(paneId).toBe("w1:p9");
    expect(run).toHaveBeenNthCalledWith(1, "herdr", [
      "pane", "split", "w1:p1",
      "--direction", "right",
      "--cwd", "/tmp/project",
      "--env", "PI_TEAM_NAME=session-team",
      "--env", "PI_AGENT_NAME=reader",
      "--env", "PI_LIFECYCLE_RUN_ID=run-1",
      "--env", "PI_AGENT_PROCESS_IDENTITY=handoff-token-1",
      "--focus",
    ], { timeoutMs: 5_000 });
    expect(run).toHaveBeenNthCalledWith(2, "herdr", [
      "pane", "run", "w1:p9", "exec pi --session '/tmp/child session.jsonl'",
    ], { timeoutMs: 5_000 });
  });

  it("applies a finite timeout to split, run, list, and close commands", () => {
    const run = vi.fn((_command: string, args: string[], _options: { timeoutMs: number }) => {
      if (args[1] === "split") {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }),
          stderr: "",
        };
      }
      if (args[1] === "list") {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p9" }] } }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "{}", stderr: "" };
    });
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run,
      commandTimeoutMs: 1_234,
    });

    const paneId = controller.createAgentPane({
      cwd: "/tmp/project",
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      processIdentity: "token-1",
    });
    controller.startAgent(paneId, "pi --session child.jsonl");
    controller.isPaneAlive(paneId);
    controller.closePane(paneId);

    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls.every(call => call[2]?.timeoutMs === 1_234)).toBe(true);
  });

  it("surfaces bounded command timeout errors", () => {
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawnSync herdr ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
      commandTimeoutMs: 50,
    });

    expect(() => controller.createAgentPane({
      cwd: "/tmp/project",
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      processIdentity: "token-1",
    })).toThrow("ETIMEDOUT");
  });

  it("refuses to act outside a Herdr-managed pane", () => {
    const run = vi.fn();
    const controller = createHerdrPaneController({ env: {}, run });

    expect(controller.isAvailable()).toBe(false);
    expect(() => controller.createAgentPane({
      cwd: "/tmp/project",
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      processIdentity: "handoff-token-1",
    })).toThrow("not running inside Herdr");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects malformed split responses instead of guessing a pane id", () => {
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: () => ({ status: 0, stdout: JSON.stringify({ result: {} }), stderr: "" }),
    });

    expect(() => controller.createAgentPane({
      cwd: "/tmp/project",
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      processIdentity: "handoff-token-1",
    })).toThrow("did not return a pane id");
  });

  it("checks exact pane liveness from Herdr's pane list", () => {
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: () => ({
        status: 0,
        stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p9" }] } }),
        stderr: "",
      }),
    });

    expect(controller.isPaneAlive("w1:p9")).toBe(true);
    expect(controller.isPaneAlive("w1:missing")).toBe(false);
  });

  it("does not treat an unavailable pane list as proof that a pane is gone", () => {
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: () => ({ status: 1, stdout: "", stderr: "Herdr unavailable" }),
    });

    expect(() => controller.isPaneAlive("w1:p9")).toThrow("Herdr pane liveness check failed");
  });

  it("treats a confirmed absent pane as already clean", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({ result: { panes: [] } }),
      stderr: "",
    }));
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run,
    });

    expect(() => controller.closePane("w1:p9")).not.toThrow();
    expect(run).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalledWith("herdr", ["pane", "close", "w1:p9"]);
  });

  it("accepts a failed close when the exact pane is confirmed gone afterward", () => {
    let listCount = 0;
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: (_command, args) => {
        if (args[1] === "close") return { status: 1, stdout: "", stderr: "pane disappeared" };
        listCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ result: { panes: listCount === 1 ? [{ pane_id: "w1:p9" }] : [] } }),
          stderr: "",
        };
      },
    });

    expect(() => controller.closePane("w1:p9")).not.toThrow();
  });

  it("surfaces pane close failures while the exact pane remains alive", () => {
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      run: (_command, args) => args[1] === "close"
        ? { status: 1, stdout: "", stderr: "pane stayed open" }
        : {
            status: 0,
            stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p9" }] } }),
            stderr: "",
          },
    });

    expect(() => controller.closePane("w1:p9")).toThrow("Herdr pane close failed: pane stayed open");
  });
});

describe("external Herdr agent readiness", () => {
  it("accepts only a live ready process for the exact lifecycle run", async () => {
    let now = 100;
    const statuses = [
      { teamName: "team", agentName: "reader", lifecycleRunId: "run-1", pid: 10, startedAt: 50, ready: true },
      { teamName: "team", agentName: "reader", lifecycleRunId: "wrong-run", pid: 20, startedAt: 110, ready: true },
      { teamName: "team", agentName: "reader", lifecycleRunId: "run-1", pid: 20, startedAt: 110, ready: false },
      {
        teamName: "team",
        agentName: "reader",
        lifecycleRunId: "run-1",
        pid: 20,
        startedAt: 110,
        ready: true,
        paneId: "w1:p9",
        processIdentity: "handoff-token-1",
      },
    ];

    const status = await waitForExternalAgentReady({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      startedAfter: 100,
      paneId: "w1:p9",
      processIdentity: "handoff-token-1",
      timeoutMs: 500,
      pollIntervalMs: 25,
    }, {
      readStatus: async () => statuses.shift() ?? null,
      isProcessAlive: pid => pid === 20,
      isPaneAlive: paneId => paneId === "w1:p9",
      processPid: 10,
      now: () => now,
      pause: async milliseconds => { now += milliseconds; },
    });

    expect(status).toMatchObject({ lifecycleRunId: "run-1", pid: 20, ready: true });
    expect(now).toBe(175);
  });

  it("rejects a live reused PID without the attempt's process identity", async () => {
    let now = 0;
    await expect(waitForExternalAgentReady({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      startedAfter: 0,
      paneId: "w1:p9",
      processIdentity: "new-token",
      timeoutMs: 25,
      pollIntervalMs: 25,
    }, {
      readStatus: async () => ({
        teamName: "team",
        agentName: "reader",
        lifecycleRunId: "run-1",
        pid: 222,
        startedAt: 1,
        ready: true,
        paneId: "w1:p9",
        processIdentity: "old-token",
      }),
      isProcessAlive: () => true,
      isPaneAlive: () => true,
      now: () => now,
      pause: async milliseconds => { now += milliseconds; },
    })).rejects.toThrow("did not become ready");
  });

  it("fails within the configured bound when pane run is accepted but Pi never becomes ready", async () => {
    let now = 0;
    const reads = vi.fn(async () => ({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      pid: 10,
      startedAt: 0,
      ready: true,
    }));

    await expect(waitForExternalAgentReady({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      startedAfter: 0,
      paneId: "w1:p9",
      processIdentity: "handoff-token-1",
      timeoutMs: 100,
      pollIntervalMs: 25,
    }, {
      readStatus: reads,
      isProcessAlive: () => true,
      isPaneAlive: () => true,
      processPid: 10,
      now: () => now,
      pause: async milliseconds => { now += milliseconds; },
    })).rejects.toThrow("did not become ready in Herdr within 100ms");
    expect(reads).toHaveBeenCalledTimes(5);
  });
});

describe("read-agent detach bound", () => {
  it("times out without consuming the eventual safe detach result", async () => {
    vi.useFakeTimers();
    try {
      let finishDetach!: (result: { status: "ready"; resumeCommand: string }) => void;
      const detach = new Promise<{ status: "ready"; resumeCommand: string }>((resolve) => {
        finishDetach = resolve;
      });
      const firstAttempt = waitForReadAgentDetach("reader", detach, 50);
      const timeoutAssertion = expect(firstAttempt).rejects.toThrow("did not detach within 50ms");

      await vi.advanceTimersByTimeAsync(50);
      await timeoutAssertion;

      finishDetach({ status: "ready", resumeCommand: "pi --session child.jsonl" });
      await expect(waitForReadAgentDetach("reader", detach, 50)).resolves.toMatchObject({ status: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("read-agent Herdr handoff transaction", () => {
  function makeState(): RunningReadAgent {
    return {
      runId: "run-1",
      name: "reader",
      startedAt: Date.now(),
      status: "working",
      teardownState: "active",
      handoffResumeCommand: "pi --session '/tmp/reader.jsonl'",
    } as RunningReadAgent;
  }

  function makeDependencies(state: RunningReadAgent) {
    const controller = {
      isAvailable: () => true,
      createAgentPane: vi.fn(() => "w1:p9"),
      startAgent: vi.fn(),
      isPaneAlive: vi.fn(() => true),
      closePane: vi.fn(),
    };
    return {
      controller,
      detach: vi.fn(async () => ({
        status: "ready" as const,
        sessionFile: "/tmp/reader.jsonl",
        resumeCommand: state.handoffResumeCommand,
      })),
      queueMessage: vi.fn(async () => {}),
      publishPendingOwner: vi.fn(async () => true),
      waitForReady: vi.fn(async () => ({
        teamName: "team",
        agentName: "reader",
        lifecycleRunId: "run-1",
        pid: 222,
        startedAt: 200,
        ready: true,
        paneId: "w1:p9",
        processIdentity: "handoff-token-1",
      })),
      publishExternalOwner: vi.fn(async (): Promise<"published" | "finalizing" | "rejected"> => "published"),
      removeInProcessState: vi.fn(),
      now: vi.fn(() => 100),
      createProcessIdentity: vi.fn(() => "handoff-token-1"),
    };
  }

  it("single-flights concurrent handoff calls for the same lifecycle run", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    let finishDetach!: (result: { status: "ready"; sessionFile: string; resumeCommand: string | undefined }) => void;
    deps.detach.mockImplementationOnce(() => new Promise(resolve => { finishDetach = resolve; }));
    const input = {
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    };

    const first = performReadAgentHerdrHandoff(input, deps);
    const second = performReadAgentHerdrHandoff(input, deps);
    expect(deps.detach).toHaveBeenCalledOnce();
    expect(deps.controller.createAgentPane).not.toHaveBeenCalled();

    finishDetach({ status: "ready", sessionFile: "/tmp/reader.jsonl", resumeCommand: state.handoffResumeCommand });
    await Promise.all([first, second]);

    expect(deps.controller.createAgentPane).toHaveBeenCalledOnce();
    expect(deps.controller.createAgentPane).toHaveBeenCalledWith(expect.objectContaining({
      processIdentity: "handoff-token-1",
    }));
    expect(deps.publishPendingOwner).toHaveBeenCalledWith("w1:p9", "handoff-token-1");
    expect(deps.publishPendingOwner.mock.invocationCallOrder[0])
      .toBeLessThan(deps.controller.startAgent.mock.invocationCallOrder[0]);
    expect(deps.controller.startAgent).toHaveBeenCalledOnce();
    expect(deps.waitForReady).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "w1:p9",
      processIdentity: "handoff-token-1",
    }));
    expect(deps.queueMessage).toHaveBeenCalledOnce();
    expect(deps.publishExternalOwner).toHaveBeenCalledOnce();
    expect(deps.removeInProcessState).toHaveBeenCalledOnce();
  });

  it("closes the unstarted pane when pending ownership publication loses to stop", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.publishPendingOwner.mockResolvedValueOnce(false);

    await expect(performReadAgentHerdrHandoff({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    }, deps)).rejects.toThrow("ownership changed before Herdr launch");

    expect(deps.controller.closePane).toHaveBeenCalledWith("w1:p9");
    expect(deps.queueMessage).not.toHaveBeenCalled();
    expect(deps.controller.startAgent).not.toHaveBeenCalled();
    expect(deps.removeInProcessState).not.toHaveBeenCalled();
  });

  it.each(["pane-create", "start", "readiness", "close", "publication"] as const)(
    "keeps the actual follow-view handoff path retryable after a %s failure",
    async failure => {
      const state = makeState();
      Object.assign(state, {
        teamName: "team",
        role: "read",
        handoffSessionFile: "/tmp/reader.jsonl",
        handoffDetached: true,
        handoffPromise: Promise.resolve({
          status: "ready" as const,
          sessionFile: "/tmp/reader.jsonl",
          resumeCommand: state.handoffResumeCommand,
        }),
        acceptingMessages: false,
        stopRequested: true,
      });
      const deps = makeDependencies(state);
      if (failure === "pane-create") {
        deps.controller.createAgentPane.mockImplementationOnce(() => { throw new Error("pane-create failed"); });
      } else if (failure === "start") {
        deps.controller.startAgent.mockImplementationOnce(() => { throw new Error("start failed"); });
      } else if (failure === "readiness") {
        deps.waitForReady.mockRejectedValueOnce(new Error("readiness failed"));
      } else if (failure === "close") {
        deps.waitForReady.mockRejectedValueOnce(new Error("readiness failed"));
        deps.controller.closePane.mockImplementationOnce(() => { throw new Error("close failed"); });
      } else {
        deps.publishExternalOwner.mockRejectedValueOnce(new Error("publication failed"));
      }
      const input = {
        teamName: "team",
        agentName: "reader",
        lifecycleRunId: "run-1",
        cwd: "/tmp/project",
        state,
      };
      const done = vi.fn();
      const component = createAgentFollowComponent(
        { terminal: { rows: 24 }, requestRender: vi.fn() },
        done,
        {
          getAgents: () => [state],
          handoffAgent: () => performReadAgentHerdrHandoff(input, deps),
        },
      );

      expect(component.render(120).join("\n")).toContain("h Retry Herdr");
      component.handleInput("h");
      await vi.waitFor(() => expect(component.render(120).join("\n")).toContain(`${failure} failed`));
      expect(done).not.toHaveBeenCalled();
      expect(component.render(120).join("\n")).toContain("h Retry Herdr");

      component.handleInput("h");
      await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
      expect(deps.removeInProcessState).toHaveBeenCalledOnce();
      component.dispose();
    },
  );

  it("keeps a detached transaction retryable after a bounded production-controller start timeout", async () => {
    const state = makeState();
    let startCalls = 0;
    const controller = createHerdrPaneController({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      commandTimeoutMs: 50,
      run: (_command, args) => {
        if (args[1] === "split") {
          return {
            status: 0,
            stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p9" } } }),
            stderr: "",
          };
        }
        if (args[1] === "run" && startCalls++ === 0) {
          return {
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawnSync herdr ETIMEDOUT"), { code: "ETIMEDOUT" }),
          };
        }
        if (args[1] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p9" }] } }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "{}", stderr: "" };
      },
    });
    const deps = { ...makeDependencies(state), controller };
    const input = {
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    };

    await expect(performReadAgentHerdrHandoff(input, deps)).rejects.toThrow("ETIMEDOUT");
    expect(state.handoffPaneId).toBeUndefined();
    await expect(performReadAgentHerdrHandoff(input, deps)).resolves.toBeUndefined();
    expect(deps.publishExternalOwner).toHaveBeenCalledOnce();
  });

  it("keeps a detached session retryable when pane run is accepted but external readiness times out", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.waitForReady.mockRejectedValueOnce(new Error("external Pi did not become ready"));

    await expect(performReadAgentHerdrHandoff({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    }, deps)).rejects.toThrow("external Pi did not become ready");

    expect(deps.controller.startAgent).toHaveBeenCalledOnce();
    expect(deps.controller.closePane).toHaveBeenCalledWith("w1:p9");
    expect(deps.publishExternalOwner).not.toHaveBeenCalled();
    expect(deps.removeInProcessState).not.toHaveBeenCalled();
    expect(state.handoffResumeCommand).toContain("--session");
    expect(state.handoffExternalReady).not.toBe(true);
  });

  it("retains an unconfirmed pane and refuses a duplicate launch until cleanup succeeds", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.waitForReady.mockRejectedValueOnce(new Error("external Pi did not become ready"));
    deps.controller.closePane.mockImplementation(() => { throw new Error("pane cleanup failed"); });
    const input = {
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    };

    await expect(performReadAgentHerdrHandoff(input, deps)).rejects.toThrow("pane cleanup failed");
    expect(state).toMatchObject({ handoffPaneId: "w1:p9" });
    expect(state.handoffExternalReady).not.toBe(true);

    await expect(performReadAgentHerdrHandoff(input, deps)).rejects.toThrow("pane cleanup failed");
    expect(deps.controller.createAgentPane).toHaveBeenCalledOnce();
    expect(deps.controller.startAgent).toHaveBeenCalledOnce();
    expect(deps.detach).toHaveBeenCalledOnce();
  });

  it.each(["detach", "message", "start"] as const)(
    "keeps the detached state and closes the unused pane after a %s failure",
    async (failure) => {
      const state = makeState();
      const deps = makeDependencies(state);
      if (failure === "detach") deps.detach.mockRejectedValueOnce(new Error("detach failed"));
      if (failure === "message") deps.queueMessage.mockRejectedValueOnce(new Error("message failed"));
      if (failure === "start") deps.controller.startAgent.mockImplementationOnce(() => { throw new Error("start failed"); });

      await expect(performReadAgentHerdrHandoff({
        teamName: "team",
        agentName: "reader",
        lifecycleRunId: "run-1",
        cwd: "/tmp/project",
        state,
      }, deps)).rejects.toThrow(`${failure} failed`);

      if (failure === "detach") {
        expect(deps.controller.createAgentPane).not.toHaveBeenCalled();
        expect(deps.controller.closePane).not.toHaveBeenCalled();
      } else {
        expect(deps.controller.closePane).toHaveBeenCalledWith("w1:p9");
      }
      expect(deps.removeInProcessState).not.toHaveBeenCalled();
      expect(deps.publishExternalOwner).not.toHaveBeenCalled();
    },
  );

  it("closes a stale external owner and fails when exact-run roster publication is refused", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.publishExternalOwner.mockResolvedValueOnce("rejected");

    await expect(performReadAgentHerdrHandoff({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    }, deps)).rejects.toThrow("lifecycle ownership changed");

    expect(deps.controller.closePane).toHaveBeenCalledWith("w1:p9");
    expect(deps.removeInProcessState).toHaveBeenCalledOnce();
    expect(state.handoffExternalReady).not.toBe(true);
  });

  it("does not close an exact external pane that already owns same-run finalization", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.publishExternalOwner.mockResolvedValueOnce("finalizing");

    await expect(performReadAgentHerdrHandoff({
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    }, deps)).resolves.toBeUndefined();

    expect(deps.controller.closePane).not.toHaveBeenCalled();
    expect(deps.removeInProcessState).toHaveBeenCalledOnce();
  });

  it("retains a proven external owner when roster publication fails and retries publication without launching twice", async () => {
    const state = makeState();
    const deps = makeDependencies(state);
    deps.publishExternalOwner.mockRejectedValueOnce(new Error("roster update failed"));
    const input = {
      teamName: "team",
      agentName: "reader",
      lifecycleRunId: "run-1",
      cwd: "/tmp/project",
      state,
    };

    await expect(performReadAgentHerdrHandoff(input, deps)).rejects.toThrow("roster update failed");
    expect(state).toMatchObject({
      handoffPaneId: "w1:p9",
      handoffExternalPid: 222,
      handoffExternalStartedAt: 200,
      handoffExternalReady: true,
    });
    expect(deps.controller.closePane).not.toHaveBeenCalled();
    expect(deps.removeInProcessState).not.toHaveBeenCalled();

    await expect(performReadAgentHerdrHandoff(input, deps)).resolves.toBeUndefined();
    expect(deps.controller.createAgentPane).toHaveBeenCalledOnce();
    expect(deps.controller.startAgent).toHaveBeenCalledOnce();
    expect(deps.queueMessage).toHaveBeenCalledOnce();
    expect(deps.publishExternalOwner).toHaveBeenCalledTimes(2);
    expect(deps.removeInProcessState).toHaveBeenCalledOnce();
  });
});
