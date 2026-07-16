import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLifecycleRuntime } from "./lifecycle.js";
import * as paths from "../../src/utils/paths.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as teams from "../../src/utils/teams.js";
import * as claims from "../../src/utils/claims.js";
import type { Member, TeamConfig } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";
import { enqueueReadAgentMessageDelivery, NESTED_SESSION_TEARDOWN_TIMEOUT_MS } from "../agents/read-agent-session-lifecycle.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";
import { registerTaskRuntimeTools } from "../tools/task-runtime-tools.js";
import { createPendingChildController } from "../runtime/pending-child-controller.js";

let root: string;
let teamsRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function member(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@scale`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    role: name === "team-lead" ? undefined : "write",
    joinedAt: Date.now(),
    tmuxPaneId: name === "team-lead" ? "" : `%${name}`,
    cwd: root,
    subscriptions: [],
    ...overrides,
  };
}

function writeConfig(config: TeamConfig) {
  fs.mkdirSync(path.dirname(paths.configPath(config.name)), { recursive: true });
  fs.writeFileSync(paths.configPath(config.name), JSON.stringify(config, null, 2));
}

describe("team lifecycle performance", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-lifecycle-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("stops and restarts the lead watchdog without leaking intervals", async () => {
    vi.useFakeTimers();
    try {
      const getTeamName = vi.fn(() => null);
      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents: new Map(),
        readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: () => true,
        renderReadAgentStatus: vi.fn(),
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName,
      });

      lifecycle.startLeadWatchdog();
      lifecycle.startLeadWatchdog();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getTeamName).toHaveBeenCalledTimes(1);

      lifecycle.stopLeadWatchdog();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTeamName).toHaveBeenCalledTimes(1);

      lifecycle.startLeadWatchdog();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getTeamName).toHaveBeenCalledTimes(2);
      lifecycle.stopLeadWatchdog();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a teammate inactive before asynchronous stop cleanup", async () => {
    const reader = member("reader", { role: "read", tmuxPaneId: "", lifecycleRunId: "run-1" });
    writeConfig({
      name: "stop-team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), reader],
    });
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "stop-team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      acceptingMessages: true,
    };
    const runningReadAgents = new Map([["stop-team:reader", state]]);
    let notifyReleaseStarted!: () => void;
    const releaseStarted = new Promise<void>((resolve) => { notifyReleaseStarted = resolve; });
    let finishRelease!: () => void;
    const releaseAllClaimsForAgent = vi.fn(() => {
      notifyReleaseStarted();
      return new Promise<string[]>((resolve) => { finishRelease = () => resolve([]); });
    });
    const pendingChildController = createPendingChildController();
    const exactParent = { teamName: "stop-team", parentName: "reader", parentRunId: "run-1" };
    const onTeammateClosing = vi.fn(() => { pendingChildController.cancelParent(exactParent); });
    const onTeammateSettled = vi.fn(() => { pendingChildController.forgetParent(exactParent); });
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent,
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "stop-team",
      onTeammateClosing,
      onTeammateSettled,
    });

    const stopping = lifecycle.shutdownTeammate("stop-team", reader);
    await releaseStarted;

    expect(onTeammateClosing).toHaveBeenCalledOnce();
    expect(onTeammateClosing).toHaveBeenCalledWith("stop-team", expect.objectContaining({
      name: "reader",
      lifecycleRunId: "run-1",
    }));
    expect(onTeammateSettled).not.toHaveBeenCalled();
    expect(pendingChildController.observeParent(exactParent).cancelled).toBe(true);
    expect(pendingChildController.trackedParentCount()).toBe(1);
    expect(state.stopRequested).toBe(true);
    expect(state.acceptingMessages).toBe(false);
    const stoppingMember = (await teams.readConfig("stop-team")).members.find(item => item.name === "reader");
    expect(stoppingMember?.isActive).toBe(false);
    const rejectedRecipient = expect(
      messaging.requireRunningMessageRecipient("stop-team", "reader")
    ).rejects.toThrow("agent is not running");

    finishRelease();
    await expect(stopping).resolves.toMatchObject({
      status: "settled",
      persistenceClosed: true,
      finalized: true,
      removedMember: true,
      releasedClaims: [],
    });
    await rejectedRecipient;
    expect(onTeammateSettled).toHaveBeenCalledOnce();
    expect(onTeammateSettled).toHaveBeenCalledWith("stop-team", expect.objectContaining({
      name: "reader",
      lifecycleRunId: "run-1",
    }));
    expect(pendingChildController.trackedParentCount()).toBe(0);
    expect(runningReadAgents.has("stop-team:reader")).toBe(false);
    expect((await teams.readConfig("stop-team")).members.map(item => item.name)).toEqual(["team-lead"]);
  });

  it("quarantines an explicit stop with stuck delivery and defers every destructive cleanup", async () => {
    vi.useFakeTimers();
    try {
      const reader = member("reader", { role: "read", tmuxPaneId: "" });
      writeConfig({
        name: "manual-stop",
        description: "",
        createdAt: Date.now(),
        leadAgentId: "lead",
        leadSessionId: "session",
        members: [member("team-lead"), reader],
      });
      let settleDelivery!: () => void;
      const rawDelivery = new Promise<void>((resolve) => { settleDelivery = resolve; });
      const session = {
        isStreaming: true,
        sendUserMessage: vi.fn(() => rawDelivery),
        hasExtensionHandlers: vi.fn(() => true),
        extensionRunner: { emit: vi.fn(async () => {}) },
        clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      const state: RunningReadAgent = {
        runId: "manual-run",
        name: "reader",
        teamName: "manual-stop",
        startedAt: Date.now(),
        tokensUsed: 0,
        status: "working",
        recentEvents: [],
        lastActivityAt: Date.now(),
        acceptingMessages: true,
        session: session as any,
      };
      const delivery = enqueueReadAgentMessageDelivery(
        state,
        state.name,
        () => session.sendUserMessage()
      ).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.sendUserMessage).toHaveBeenCalledOnce();

      const runningReadAgents = new Map([["manual-stop:reader", state]]);
      const releaseAllClaimsForAgent = vi.fn(async () => []);
      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents,
        readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key, candidate) => runningReadAgents.get(key) === candidate,
        renderReadAgentStatus: vi.fn(),
        releaseAllClaimsForAgent,
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "manual-stop",
      });

      const stopping = lifecycle.shutdownTeammate("manual-stop", reader);
      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
      await expect(stopping).resolves.toMatchObject({
        status: "timed_out",
        reason: "quit",
        cancelledDeliveries: 1,
      });
      await expect(delivery).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("was cancelled") }));
      expect((await teams.readConfig("manual-stop")).members.find(item => item.name === "reader")?.isActive).toBe(false);
      expect(state.teardownState).toBe("quarantined");
      expect(runningReadAgents.has("manual-stop:reader")).toBe(true);
      expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
      expect(session.dispose).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      settleDelivery();
      await state.teardownFinalizationPromise;
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(releaseAllClaimsForAgent).toHaveBeenCalledOnce();
      expect(runningReadAgents.has("manual-stop:reader")).toBe(false);
      expect((await teams.readConfig("manual-stop")).members.map(item => item.name)).toEqual(["team-lead"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("protects a newer same-name state, member, runtime, and claim from an old deferred finalizer", async () => {
    vi.useFakeTimers();
    try {
      const oldMember = member("reader", { role: "read", tmuxPaneId: "", joinedAt: 100 });
      writeConfig({
        name: "replacement-team",
        description: "",
        createdAt: Date.now(),
        leadAgentId: "lead",
        leadSessionId: "session",
        members: [member("team-lead"), oldMember],
      });
      let settleDelivery!: () => void;
      const oldState: RunningReadAgent = {
        runId: "old-run",
        name: "reader",
        teamName: "replacement-team",
        startedAt: 100,
        tokensUsed: 0,
        status: "working",
        recentEvents: [],
        lastActivityAt: 100,
        acceptingMessages: true,
        messageDeliveryTail: new Promise<void>((resolve) => { settleDelivery = resolve; }),
        session: {
          hasExtensionHandlers: vi.fn(() => false),
          clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
          abort: vi.fn(async () => {}),
          dispose: vi.fn(),
        } as any,
      };
      const runningReadAgents = new Map([["replacement-team:reader", oldState]]);
      const releaseClaims = vi.fn((teamName: string, agentName: string) => claims.releaseAllForAgent(teamName, agentName));
      const drainWriteQueue = vi.fn(async () => {});
      const deleteRuntimeStatus = vi.spyOn(runtime, "deleteRuntimeStatus");
      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents,
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
        renderReadAgentStatus: vi.fn(),
        releaseAllClaimsForAgent: releaseClaims,
        drainWriteQueue,
        getSessionCwd: () => root,
        getTeamName: () => "replacement-team",
      });

      const stopping = lifecycle.shutdownTeammate("replacement-team", oldMember);
      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
      await expect(stopping).resolves.toMatchObject({ status: "timed_out", finalized: false, removedMember: false });

      const newMember = member("reader", { role: "read", tmuxPaneId: "", lifecycleRunId: "new-run", joinedAt: 999, isActive: true });
      writeConfig({
        name: "replacement-team",
        description: "",
        createdAt: Date.now(),
        leadAgentId: "lead",
        leadSessionId: "session",
        members: [member("team-lead"), newMember],
      });
      const newState: RunningReadAgent = {
        ...oldState,
        runId: "new-run",
        startedAt: 999,
        messageDeliveryTail: undefined,
        session: undefined,
        teardownState: "active",
      };
      runningReadAgents.set("replacement-team:reader", newState);
      fs.mkdirSync(path.dirname(paths.runtimeStatusPath("replacement-team", "reader")), { recursive: true });
      fs.writeFileSync(paths.runtimeStatusPath("replacement-team", "reader"), JSON.stringify({
        teamName: "replacement-team",
        agentName: "reader",
        lifecycleRunId: "new-run",
        ready: true,
        startedAt: 999,
        lastHeartbeatAt: 999,
      }, null, 2));
      fs.writeFileSync(paths.claimsPath("replacement-team"), JSON.stringify({
        "src/new.ts": { agent: "reader", path: "src/new.ts", since: 999 },
      }, null, 2));

      settleDelivery();
      await oldState.teardownFinalizationPromise;

      expect(runningReadAgents.get("replacement-team:reader")).toBe(newState);
      expect((await teams.readConfig("replacement-team")).members.find(item => item.name === "reader")).toMatchObject({ joinedAt: 999, isActive: true });
      expect(await runtime.readRuntimeStatus("replacement-team", "reader")).toMatchObject({ startedAt: 999, ready: true });
      expect(await claims.listClaims("replacement-team")).toEqual([
        { agent: "reader", path: "src/new.ts", since: 999 },
      ]);
      expect(releaseClaims).not.toHaveBeenCalled();
      expect(deleteRuntimeStatus).not.toHaveBeenCalled();
      expect(drainWriteQueue).not.toHaveBeenCalled();
      expect(oldState.teardownState).toBe("quarantined");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences an absent member across extension instances until matching late proof clears", async () => {
    vi.useFakeTimers();
    try {
      const oldMember = member("reader", {
        role: "read",
        tmuxPaneId: "",
        lifecycleRunId: "run-a",
      });
      writeConfig({
        name: "cross-instance",
        description: "",
        createdAt: Date.now(),
        leadAgentId: "lead",
        leadSessionId: "session",
        members: [member("team-lead"), oldMember],
      });
      await runtime.writeRuntimeStatus("cross-instance", "reader", "run-a", {
        ready: true,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
      let settleDelivery!: () => void;
      const stateA: RunningReadAgent = {
        runId: "run-a",
        name: "reader",
        teamName: "cross-instance",
        role: "read",
        startedAt: Date.now(),
        tokensUsed: 0,
        status: "working",
        recentEvents: [],
        lastActivityAt: Date.now(),
        acceptingMessages: true,
        messageDeliveryTail: new Promise<void>(resolve => { settleDelivery = resolve; }),
      };
      const mapA = new Map([["cross-instance:reader", stateA]]);
      const lifecycleA = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents: mapA,
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key, state) => mapA.get(key) === state,
        renderReadAgentStatus: vi.fn(),
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "cross-instance",
        extensionInstanceId: "extension-a",
      });
      vi.spyOn(teams, "updateMember").mockResolvedValueOnce();

      const firstStop = lifecycleA.shutdownTeammate("cross-instance", oldMember);
      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
      const bounded = await firstStop;
      expect(bounded.status).toBe("timed_out");
      expect((await teams.readConfig("cross-instance")).members.map(item => item.name)).toEqual(["team-lead"]);
      await expect(readLifecycleTombstone("cross-instance", "reader")).resolves.toMatchObject({
        status: "occupied",
        tombstone: { runId: "run-a", extensionInstanceId: "extension-a" },
      });

      const mapB = new Map<string, RunningReadAgent>();
      const lifecycleB = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents: mapB,
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key, state) => mapB.get(key) === state,
        renderReadAgentStatus: vi.fn(),
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "cross-instance",
        extensionInstanceId: "extension-b",
      });
      const toolsB = new Map<string, any>();
      registerTaskRuntimeTools({ registerTool: (tool: any) => toolsB.set(tool.name, tool) }, {
        isTeammate: false,
        terminal: null,
        runningReadAgents: mapB,
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        shutdownTeammate: lifecycleB.shutdownTeammate,
        getTeamName: () => "cross-instance",
      });

      await expect(toolsB.get("check_teammate").execute("check", { agent_name: "reader" })).resolves.toMatchObject({
        details: { alive: false, health: "quarantined", removedMember: false },
      });
      await expect(toolsB.get("stop_teammate").execute("stop", { agent_name: "reader" })).resolves.toMatchObject({
        details: { stopped: false, quarantined: true, blocked: true },
      });
      const newMember = member("reader", { role: "read", tmuxPaneId: "", lifecycleRunId: undefined });
      await expect(teams.addMember("cross-instance", newMember)).rejects.toThrow("lifecycle-quarantined");
      expect(mapB.size).toBe(0);

      settleDelivery();
      await stateA.teardownFinalizationPromise;
      expect(mapA.size).toBe(0);
      await expect(readLifecycleTombstone("cross-instance", "reader")).resolves.toEqual({ status: "absent" });

      await teams.addMember("cross-instance", newMember);
      expect(newMember.lifecycleRunId).toBeTruthy();
      expect(newMember.lifecycleRunId).not.toBe("run-a");
      await runtime.writeRuntimeStatus("cross-instance", "reader", newMember.lifecycleRunId!, {
        ready: true,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      });
      const stateB: RunningReadAgent = {
        ...stateA,
        runId: newMember.lifecycleRunId!,
        teardownState: "active",
        messageDeliveryTail: undefined,
      };
      mapB.set("cross-instance:reader", stateB);

      await expect(lifecycleA.shutdownTeammate("cross-instance", oldMember)).resolves.toMatchObject({
        status: "timed_out",
        finalized: false,
      });
      expect(mapB.get("cross-instance:reader")).toBe(stateB);
      expect((await teams.readConfig("cross-instance")).members.find(item => item.name === "reader")?.lifecycleRunId).toBe(newMember.lifecycleRunId);
      expect(await runtime.readRuntimeStatus("cross-instance", "reader")).toMatchObject({
        lifecycleRunId: newMember.lifecycleRunId,
        ready: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a persistence-failed state and session without destructive fallback", async () => {
    const reader = member("reader", { role: "read", tmuxPaneId: "" });
    writeConfig({
      name: "persistence-team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), reader],
    });
    const session = {
      hasExtensionHandlers: vi.fn(() => true),
      extensionRunner: { emit: vi.fn(async () => {}) },
      clearQueue: vi.fn(),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const state: RunningReadAgent = {
      runId: "persist-run",
      name: reader.name,
      teamName: "persistence-team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
    };
    const runningReadAgents = new Map([["persistence-team:reader", state]]);
    const releaseClaims = vi.fn(async () => []);
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, candidate) => runningReadAgents.get(key) === candidate,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: releaseClaims,
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "persistence-team",
    });
    fs.writeFileSync(paths.configPath("persistence-team"), "{ malformed config");

    await expect(lifecycle.shutdownTeammate("persistence-team", reader)).resolves.toMatchObject({
      status: "persistence_failed",
      persistenceClosed: false,
      finalized: false,
      removedMember: false,
      releasedClaims: [],
    });
    expect(state.teardownState).toBe("persistence_failed");
    expect(runningReadAgents.get("persistence-team:reader")).toBe(state);
    expect(fs.readFileSync(paths.configPath("persistence-team"), "utf-8")).toBe("{ malformed config");
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(releaseClaims).not.toHaveBeenCalled();
  });

  it("retains the matching tombstone when nested session disposal fails", async () => {
    const reader = member("dispose-failure", {
      role: "read",
      tmuxPaneId: "",
      lifecycleRunId: "dispose-run",
    });
    writeConfig({
      name: "dispose-failure-team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), reader],
    });
    const state: RunningReadAgent = {
      runId: "dispose-run",
      name: reader.name,
      teamName: "dispose-failure-team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: {
        hasExtensionHandlers: vi.fn(() => false),
        clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(() => { throw new Error("dispose failed"); }),
      } as any,
    };
    const runningReadAgents = new Map([["dispose-failure-team:dispose-failure", state]]);
    const pendingChildController = createPendingChildController();
    const exactParent = {
      teamName: "dispose-failure-team",
      parentName: reader.name,
      parentRunId: "dispose-run",
    };
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, candidate) => runningReadAgents.get(key) === candidate,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "dispose-failure-team",
      onTeammateClosing: () => { pendingChildController.cancelParent(exactParent); },
      onTeammateSettled: () => { pendingChildController.forgetParent(exactParent); },
    });

    await expect(lifecycle.shutdownTeammate("dispose-failure-team", reader)).resolves.toMatchObject({
      status: "cleanup_failed",
      dispose: "failed",
      finalized: false,
    });
    expect((await teams.readConfig("dispose-failure-team")).members.find(item => item.name === reader.name)?.isActive).toBe(false);
    await expect(readLifecycleTombstone("dispose-failure-team", reader.name)).resolves.toMatchObject({
      status: "occupied",
      tombstone: { runId: "dispose-run", phase: "cleanup_failed" },
    });
    expect(runningReadAgents.get("dispose-failure-team:dispose-failure")).toBe(state);
    expect(pendingChildController.observeParent(exactParent).cancelled).toBe(true);
    expect(pendingChildController.trackedParentCount()).toBe(1);
  });

  it("classifies claim-release and member-removal failures without claiming finalization", async () => {
    const releaseMember = member("release-failure", { role: "read", tmuxPaneId: "" });
    writeConfig({
      name: "cleanup-failures",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), releaseMember],
    });
    const releaseFailureLifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => { throw new Error("claims unavailable"); }),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "cleanup-failures",
    });

    await expect(releaseFailureLifecycle.shutdownTeammate("cleanup-failures", releaseMember)).resolves.toMatchObject({
      status: "cleanup_failed",
      finalized: false,
      removedMember: false,
      releasedClaims: [],
      error: "claims unavailable",
    });
    expect((await teams.readConfig("cleanup-failures")).members.find(item => item.name === releaseMember.name)?.isActive).toBe(false);

    const removalMember = member("removal-failure", { role: "read", tmuxPaneId: "" });
    await teams.addMember("cleanup-failures", removalMember);
    const removeMember = vi.spyOn(teams, "removeMemberMatchingRun").mockRejectedValueOnce(new Error("roster unavailable"));
    const removalFailureLifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => ["src/owned.ts"]),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "cleanup-failures",
    });

    await expect(removalFailureLifecycle.shutdownTeammate("cleanup-failures", removalMember)).resolves.toMatchObject({
      status: "cleanup_failed",
      finalized: false,
      removedMember: false,
      releasedClaims: ["src/owned.ts"],
      error: "roster unavailable",
    });
    expect(removeMember).toHaveBeenCalledWith("cleanup-failures", "removal-failure", removalMember.lifecycleRunId);
  });

  it("preserves proven member removal when a later queue drain fails", async () => {
    const writer = member("drain-failure");
    writeConfig({
      name: "drain-failure-team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), writer],
    });
    const drainWriteQueue = vi.fn(async () => { throw new Error("queue unavailable"); });
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => ["src/released.ts"]),
      drainWriteQueue,
      getSessionCwd: () => root,
      getTeamName: () => "drain-failure-team",
    });

    await expect(lifecycle.shutdownTeammate("drain-failure-team", writer)).resolves.toMatchObject({
      status: "cleanup_failed",
      finalized: false,
      removedMember: true,
      releasedClaims: ["src/released.ts"],
      error: "queue unavailable",
    });
    expect(drainWriteQueue).toHaveBeenCalledOnce();
    expect((await teams.readConfig("drain-failure-team")).members.map(item => item.name)).toEqual(["team-lead"]);
  });

  it("does not reap a watchdog-stale member while its in-process state is still live", async () => {
    const reader = member("live-reader", { role: "read", tmuxPaneId: "" });
    writeConfig({
      name: "watchdog-live",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), reader],
    });
    const session = {
      hasExtensionHandlers: vi.fn(() => true),
      extensionRunner: { emit: vi.fn(async () => {}) },
      clearQueue: vi.fn(),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const state: RunningReadAgent = {
      runId: "live-run",
      name: reader.name,
      teamName: "watchdog-live",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
    };
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "watchdog-live",
      agentName: reader.name,
      ready: true,
      startedAt: Date.now() - 600_000,
      lastHeartbeatAt: Date.now() - 600_000,
    });
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    const runningReadAgents = new Map([["watchdog-live:live-reader", state]]);
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, candidate) => runningReadAgents.get(key) === candidate,
      renderReadAgentStatus: vi.fn(),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "watchdog-live",
    });

    await lifecycle.runWatchdogOnce("watchdog-live");

    expect((await teams.readConfig("watchdog-live")).members.map(item => item.name)).toEqual(["team-lead", "live-reader"]);
    expect(runningReadAgents.has("watchdog-live:live-reader")).toBe(true);
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("retains an inactive watchdog candidate when structured shutdown cleanup fails", async () => {
    const stale = member("blocked-writer", { tmuxPaneId: "%blocked" });
    writeConfig({
      name: "watchdog-blocked",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead"), stale],
    });
    const drainWriteQueue = vi.fn(async () => {});
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "watchdog-blocked",
      agentName: stale.name,
      ready: true,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    const sendNotice = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: { isAlive: vi.fn(() => false), kill: vi.fn() },
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => { throw new Error("claims unavailable"); }),
      drainWriteQueue,
      getSessionCwd: () => root,
      getTeamName: () => "watchdog-blocked",
    });

    await lifecycle.runWatchdogOnce("watchdog-blocked");

    const retained = (await teams.readConfig("watchdog-blocked")).members.find(item => item.name === stale.name);
    expect(retained).toMatchObject({ isActive: false });
    expect(sendNotice).not.toHaveBeenCalled();
    expect(drainWriteQueue).not.toHaveBeenCalled();
  });

  it("batch-removes watchdog-reaped teammates and drains the write queue once", async () => {
    const config: TeamConfig = {
      name: "scale",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member("gone-1", { tmuxPaneId: "%gone-1" }),
        member("gone-2", { tmuxPaneId: "%gone-2" }),
        member("alive", { tmuxPaneId: "%alive" }),
      ],
    };
    writeConfig(config);

    const terminal = {
      isAlive: vi.fn((paneId: string) => paneId === "%alive"),
      kill: vi.fn(),
    };
    const drainWriteQueue = vi.fn(async () => {});
    const removeMemberSpy = vi.spyOn(teams, "removeMemberMatchingRun");
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (teamName: string, agentName: string) => ({
      teamName,
      agentName,
      ready: true,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    }));
    vi.spyOn(runtime, "deleteRuntimeStatus").mockResolvedValue(true);
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);

    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal,
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      drainWriteQueue,
      getSessionCwd: () => root,
      getTeamName: () => "scale",
    });

    await lifecycle.runWatchdogOnce("scale");

    const updated = JSON.parse(fs.readFileSync(paths.configPath("scale"), "utf-8")) as TeamConfig;
    expect(updated.members.map((item) => item.name)).toEqual(["team-lead", "alive"]);
    expect(removeMemberSpy).toHaveBeenCalledTimes(2);
    expect(drainWriteQueue).toHaveBeenCalledTimes(1);
    expect(terminal.kill).toHaveBeenCalledTimes(2);
    expect(messaging.sendPlainMessage).toHaveBeenCalledTimes(2);
  });

  it("unlinks writer pid files when watchdog kill finds a dead process", async () => {
    const config: TeamConfig = {
      name: "stale-pid",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member("gone", { tmuxPaneId: "%gone" }),
      ],
    };
    writeConfig(config);
    const pidFile = path.join(paths.teamDir("stale-pid"), "gone.pid");
    fs.writeFileSync(pidFile, "99999999");

    const killError = Object.assign(new Error("process is gone"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw killError;
    }) as typeof process.kill);
    const terminal = {
      isAlive: vi.fn(() => false),
      kill: vi.fn(),
    };
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "stale-pid",
      agentName: "gone",
      ready: true,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    vi.spyOn(runtime, "deleteRuntimeStatus").mockResolvedValue(true);
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);

    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal,
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "stale-pid",
    });

    await lifecycle.runWatchdogOnce("stale-pid");

    expect(fs.existsSync(pidFile)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(99999999, "SIGKILL");
    expect(terminal.kill).toHaveBeenCalledWith("%gone");
  });
});
