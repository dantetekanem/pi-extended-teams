import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../../src/utils/models";

const mocks = vi.hoisted(() => ({
  addMember: vi.fn(async (_teamName: string, member: Member) => { member.lifecycleRunId = "writer-run"; }),
  removeMember: vi.fn(async () => {}),
  removeMemberMatchingRun: vi.fn(async () => true),
  updateMember: vi.fn(async () => {}),
  readConfig: vi.fn(async (): Promise<{ members: Member[] }> => ({ members: [] })),
  sendPlainMessage: vi.fn(async () => {}),
  sendPlainMessageOnceIfRunning: vi.fn(async () => ({ delivered: true })),
  removeInboxMessagesByOperationUnderLifecycleLock: vi.fn(async () => 1),
  writeRuntimeStatus: vi.fn(async () => ({})),
  deleteRuntimeStatus: vi.fn(async () => true),
  writeTeamsDebugEvent: vi.fn(async (..._args: any[]) => {}),
  occupyLifecycleTombstone: vi.fn(),
  updateLifecycleTombstone: vi.fn(),
  withLifecycleTombstoneLock: vi.fn(async (_teamName: string, _agentName: string, fn: Function) => fn({
    read: () => ({ status: "absent" }),
    occupy: mocks.occupyLifecycleTombstone,
    updateMatching: mocks.updateLifecycleTombstone,
  })),
  deleteRuntimeStatusUnderLifecycleLock: vi.fn(async () => true),
  cleanupPrivateAgentSessionDirectory: vi.fn(),
  checkModel: vi.fn((
    _piBinary: string,
    _model: string | undefined,
    _extensions: readonly string[],
    _options: { projectTrusted?: boolean; selfExtensionSource?: string },
  ) => ({
    status: "available",
    command: "preflight",
    stdout: "",
    stderr: "",
    exitStatus: 0,
  })),
  buildCommand: vi.fn((
    _piBinary: string,
    _model: string | undefined,
    _thinking: string | undefined,
    _extensions: readonly string[],
    projectTrusted?: boolean,
    _selfExtensionSource?: string,
    sessionDir?: string,
  ) => `pi ${projectTrusted ? "--approve" : "--no-approve"} --no-extensions --extension 'self.ts' --extension '/external/$safe.ts'${sessionDir ? ` --session-dir '${sessionDir}'` : ""}`),
  showInResume: false,
  favoriteLevel: {
    slot: "writing-hard",
    role: "write",
    model: "provider/model",
    thinking: "xhigh",
  },
}));

vi.mock("../../src/utils/settings", () => ({
  loadSettings: vi.fn(() => ({
    debug: { enabled: false },
    agentSessions: { showInResume: mocks.showInResume },
  })),
  requireFavoriteModelLevel: vi.fn(() => mocks.favoriteLevel),
}));
vi.mock("../../src/utils/teams", () => ({
  addMember: mocks.addMember,
  removeMember: mocks.removeMember,
  removeMemberMatchingRun: mocks.removeMemberMatchingRun,
  updateMember: mocks.updateMember,
  readConfig: mocks.readConfig,
}));
vi.mock("../../src/utils/messaging", () => ({
  sendPlainMessage: mocks.sendPlainMessage,
  sendPlainMessageOnceIfRunning: mocks.sendPlainMessageOnceIfRunning,
  removeInboxMessagesByOperationUnderLifecycleLock: mocks.removeInboxMessagesByOperationUnderLifecycleLock,
}));
vi.mock("../../src/utils/runtime", () => ({
  writeRuntimeStatus: mocks.writeRuntimeStatus,
  deleteRuntimeStatus: mocks.deleteRuntimeStatus,
  deleteRuntimeStatusUnderLifecycleLock: mocks.deleteRuntimeStatusUnderLifecycleLock,
}));
vi.mock("../internal/debug", () => ({
  isTeamsDebugEnabled: () => false,
  teamDebugLogPath: () => undefined,
  writeTeamsDebugEvent: mocks.writeTeamsDebugEvent,
}));
vi.mock("../internal/pi-command", () => ({
  buildPiCommand: mocks.buildCommand,
  checkChildPiModelAvailability: mocks.checkModel,
  getPiExtendedTeamsExtensionSource: () => "self.ts",
  getPiLaunchCommand: () => "pi",
}));
vi.mock("../internal/agent-session-files", () => ({
  preparePrivateAgentSessionDirectory: (teamName: string, agentName: string, runId: string) => {
    return `/private/${teamName}/${agentName}/${runId}`;
  },
  cleanupPrivateAgentSessionDirectory: vi.fn((...args: any[]) => mocks.cleanupPrivateAgentSessionDirectory(...args)),
}));
vi.mock("../team/roster", () => ({ countWriteMembers: vi.fn(async () => 0) }));
vi.mock("../../src/utils/lifecycle-tombstone", () => ({
  readLifecycleTombstone: vi.fn(async () => ({ status: "absent" })),
  withLifecycleTombstoneLock: mocks.withLifecycleTombstoneLock,
  generateExtensionInstanceId: () => "extension-instance",
}));

import { createWriteAgentRuntime } from "./write-agent";

function writer(): Member {
  return {
    agentId: "writer@team",
    name: "writer",
    agentType: "teammate",
    role: "write",
    model: "provider/model",
    thinking: "xhigh",
    modelSlot: "writing-hard",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: "/trusted/project",
    subscriptions: [],
    prompt: "write",
  };
}

describe("legacy tmux writer resource plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfig.mockImplementation(async () => ({ members: [] }));
    mocks.updateMember.mockImplementation(async () => {});
    mocks.writeTeamsDebugEvent.mockImplementation(async () => {});
    mocks.cleanupPrivateAgentSessionDirectory.mockImplementation(() => {});
    mocks.showInResume = false;
    mocks.favoriteLevel = {
      slot: "writing-hard",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
    };
  });

  it("uses canonical write-* intent-tier wording for read-tier validation failures", async () => {
    mocks.favoriteLevel = {
      slot: "read-review",
      role: "read",
      model: "provider/model",
      thinking: "xhigh",
    };
    const runtime = createWriteAgentRuntime({ terminal: { spawn: vi.fn() } });

    await expect(runtime.startWriteAgent("team", writer(), "implement the task")).rejects.toThrow(
      "Write agent writer must use a write-* intent tier configured via /agents-favorite-models. Spawn agents by intent tier only."
    );
  });

  it("releases the failed writer's sleep assertion even when a replacement run is admitted", async () => {
    let replacementAdmitted = false;
    let notifyFailureLogged!: () => void;
    const failureLogged = new Promise<void>(resolve => { notifyFailureLogged = resolve; });
    let releaseFailureLog!: () => void;
    const failureLogBarrier = new Promise<void>(resolve => { releaseFailureLog = resolve; });
    mocks.writeTeamsDebugEvent.mockImplementation(async (_teamName: string, eventName: string) => {
      if (eventName !== "write-agent.spawn.failure") return;
      notifyFailureLogged();
      await failureLogBarrier;
    });
    mocks.readConfig.mockImplementation(async () => ({
      members: replacementAdmitted
        ? [{ ...writer(), lifecycleRunId: "replacement-run", tmuxPaneId: "%replacement" }]
        : [],
    }));
    const onWriterInactive = vi.fn();
    const releaseSleepAssertion = vi.fn();
    const sleepController = {
      retain: vi.fn(() => releaseSleepAssertion),
      dispose: vi.fn(),
    };
    const runtime = createWriteAgentRuntime({
      terminal: { spawn: vi.fn(() => { throw new Error("spawn failed"); }) },
      onWriterInactive,
      sleepController,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    const launch = runtime.startWriteAgent("team", writer(), "implement the task");
    await failureLogged;
    replacementAdmitted = true;
    releaseFailureLog();

    await expect(launch).rejects.toThrow("Failed to spawn background tmux screen: Error: spawn failed");
    expect(mocks.withLifecycleTombstoneLock).toHaveBeenCalledWith("team", "writer", expect.any(Function));
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.removeMemberMatchingRun).not.toHaveBeenCalled();
    expect(onWriterInactive).not.toHaveBeenCalled();
    expect(sleepController.retain).toHaveBeenCalledOnce();
    expect(releaseSleepAssertion).toHaveBeenCalledOnce();
  });

  it("holds a sleep assertion until the successful writer lifecycle is released", async () => {
    const releaseSleepAssertion = vi.fn();
    const sleepController = {
      retain: vi.fn(() => releaseSleepAssertion),
      dispose: vi.fn(),
    };
    const runtime = createWriteAgentRuntime({
      terminal: {
        spawn: vi.fn(() => "%writer"),
        getWindowIdForPane: vi.fn(() => "@writer"),
      },
      sleepController,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });
    const member = writer();

    await runtime.startWriteAgent("team", member, "implement the task");

    expect(sleepController.retain).toHaveBeenCalledOnce();
    expect(releaseSleepAssertion).not.toHaveBeenCalled();

    runtime.releaseWriteAgentSleepAssertion("team", member);
    runtime.releaseWriteAgentSleepAssertion("team", member);
    expect(releaseSleepAssertion).toHaveBeenCalledOnce();
  });

  it("stops and verifies a returned R1 pane before diagnostics and leaves an R2 replacement untouched", async () => {
    const admitted = writer();
    const replacement = { ...writer(), lifecycleRunId: "replacement-run", tmuxPaneId: "%r2" };
    let replacementInstalled = false;
    mocks.updateMember.mockRejectedValueOnce(new Error("update failed"));
    mocks.writeTeamsDebugEvent.mockImplementation(async (_teamName: string, eventName: string) => {
      if (eventName === "write-agent.spawn.failure") replacementInstalled = true;
    });
    mocks.readConfig.mockImplementation(async () => ({
      members: replacementInstalled ? [replacement] : [admitted],
    }));
    mocks.withLifecycleTombstoneLock.mockImplementationOnce(async (_teamName: string, _agentName: string, fn: Function) => fn({
      read: () => replacementInstalled
        ? { status: "occupied", tombstone: { runId: "replacement-run" } }
        : { status: "absent" },
      occupy: mocks.occupyLifecycleTombstone,
      updateMatching: mocks.updateLifecycleTombstone,
    }));
    const terminal = {
      spawn: vi.fn(() => "%r1"),
      kill: vi.fn(),
      isAlive: vi.fn(() => false),
    };
    const onWriterInactive = vi.fn();
    const runtime = createWriteAgentRuntime({
      terminal,
      onWriterInactive,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    await expect(runtime.startWriteAgent("team", admitted, "implement the task")).rejects.toThrow(
      "Failed to spawn background tmux screen: Error: update failed",
    );

    const failureDiagnosticIndex = mocks.writeTeamsDebugEvent.mock.calls.findIndex(call => call[1] === "write-agent.spawn.failure");
    expect(terminal.kill).toHaveBeenCalledWith("%r1");
    expect(terminal.isAlive).toHaveBeenCalledWith("%r1");
    expect(terminal.isAlive.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeTeamsDebugEvent.mock.invocationCallOrder[failureDiagnosticIndex]!,
    );
    expect(onWriterInactive).not.toHaveBeenCalled();
    expect(mocks.removeMemberMatchingRun).not.toHaveBeenCalled();
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.removeInboxMessagesByOperationUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.cleanupPrivateAgentSessionDirectory).not.toHaveBeenCalled();
    expect(mocks.occupyLifecycleTombstone).not.toHaveBeenCalled();
    expect(mocks.updateLifecycleTombstone).not.toHaveBeenCalled();
  });

  it("does not fence or delete R2 state when R1 pane termination cannot be proven", async () => {
    const admitted = writer();
    const replacement = { ...writer(), lifecycleRunId: "replacement-run", tmuxPaneId: "%r2" };
    let replacementInstalled = false;
    mocks.updateMember.mockRejectedValueOnce(new Error("update failed"));
    mocks.writeTeamsDebugEvent.mockImplementation(async (_teamName: string, eventName: string) => {
      if (eventName === "write-agent.spawn.failure") replacementInstalled = true;
    });
    mocks.readConfig.mockImplementation(async () => ({
      members: replacementInstalled ? [replacement] : [admitted],
    }));
    mocks.withLifecycleTombstoneLock.mockImplementationOnce(async (_teamName: string, _agentName: string, fn: Function) => fn({
      read: () => replacementInstalled
        ? { status: "occupied", tombstone: { runId: "replacement-run" } }
        : { status: "absent" },
      occupy: mocks.occupyLifecycleTombstone,
      updateMatching: mocks.updateLifecycleTombstone,
    }));
    const terminal = {
      spawn: vi.fn(() => "%r1"),
      kill: vi.fn(),
      isAlive: vi.fn(() => true),
    };
    const runtime = createWriteAgentRuntime({
      terminal,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    await expect(runtime.startWriteAgent("team", admitted, "implement the task")).rejects.toThrow(
      "Failed to spawn background tmux screen: Error: update failed",
    );

    expect(terminal.kill).toHaveBeenCalledWith("%r1");
    expect(terminal.isAlive).toHaveBeenCalledWith("%r1");
    expect(mocks.removeMemberMatchingRun).not.toHaveBeenCalled();
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.removeInboxMessagesByOperationUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.cleanupPrivateAgentSessionDirectory).not.toHaveBeenCalled();
    expect(mocks.occupyLifecycleTombstone).not.toHaveBeenCalled();
    expect(mocks.updateLifecycleTombstone).not.toHaveBeenCalled();
  });

  it("uses one immutable plan for preflight and spawn and propagates its trust snapshot", async () => {
    const extensionPaths = Object.freeze(["/external/$safe.ts"]);
    const plan = Object.freeze({
      selectionMode: "explicit" as const,
      extensionPaths,
      selfExtensionPath: "self.ts",
      extensions: Object.freeze([]),
      diagnostics: Object.freeze([]),
      skills: "all" as const,
      trust: Object.freeze({ cwd: "/trusted/project", projectTrusted: true }),
    });
    const createResourcePlan = vi.fn(async () => plan);
    const terminal = {
      spawn: vi.fn(() => "%writer"),
      getWindowIdForPane: vi.fn(() => "@writer"),
    };
    const runtime = createWriteAgentRuntime({
      terminal,
      getProjectTrusted: (cwd) => cwd === "/trusted/project",
      createResourcePlan,
    });

    await runtime.startWriteAgent("team", writer(), "implement the task");

    expect(createResourcePlan).toHaveBeenCalledOnce();
    expect(createResourcePlan).toHaveBeenCalledWith({ cwd: "/trusted/project", projectTrusted: true });
    expect(mocks.checkModel.mock.calls[0]?.[2]).toBe(extensionPaths);
    expect(mocks.checkModel.mock.calls[0]?.[3]).toEqual({ projectTrusted: true, selfExtensionSource: "self.ts" });
    expect(mocks.buildCommand.mock.calls[0]?.[3]).toBe(extensionPaths);
    expect(mocks.buildCommand.mock.calls[0]?.[4]).toBe(true);
    expect(mocks.buildCommand.mock.calls[0]?.[5]).toBe("self.ts");
    expect(mocks.buildCommand.mock.calls[0]?.[6]).toBe("/private/team/writer/writer-run");
    expect(mocks.buildCommand.mock.calls[0]).toHaveLength(7);
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/trusted/project",
      command: expect.stringContaining("--session-dir '/private/team/writer/writer-run'"),
    }));
    expect(mocks.addMember).toHaveBeenCalledOnce();
    expect(mocks.sendPlainMessageOnceIfRunning).toHaveBeenCalledWith(
      "team",
      "team-lead",
      "writer",
      "implement the task",
      "Initial prompt",
      {
        operationId: "bootstrap:writer-run:initial-prompt",
        expectedRecipientRunId: "writer-run",
      },
    );
    expect(mocks.updateMember).toHaveBeenCalledWith("team", "writer", {
      tmuxPaneId: "%writer",
      windowId: "@writer",
    });
  });

  it("stops and verifies the exact spawned pane before rolling back an updateMember failure", async () => {
    const admitted = writer();
    mocks.readConfig.mockImplementation(async () => ({ members: [admitted] }));
    mocks.updateMember.mockRejectedValueOnce(new Error("update failed"));
    const terminal = {
      spawn: vi.fn(() => "%writer"),
      kill: vi.fn(),
      isAlive: vi.fn(() => false),
    };
    const onWriterInactive = vi.fn();
    const runtime = createWriteAgentRuntime({
      terminal,
      onWriterInactive,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    await expect(runtime.startWriteAgent("team", admitted, "implement the task")).rejects.toThrow(
      "Failed to spawn background tmux screen: Error: update failed",
    );

    expect(terminal.kill).toHaveBeenCalledWith("%writer");
    expect(terminal.isAlive).toHaveBeenCalledWith("%writer");
    expect(onWriterInactive).toHaveBeenCalledWith("team", expect.objectContaining({ lifecycleRunId: "writer-run" }));
    expect(mocks.removeInboxMessagesByOperationUnderLifecycleLock).toHaveBeenCalledWith(
      "team", "writer", "bootstrap:writer-run:initial-prompt",
    );
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).toHaveBeenCalledWith("team", "writer", "writer-run");
    expect(terminal.isAlive.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteRuntimeStatusUnderLifecycleLock.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeMemberMatchingRun).toHaveBeenCalledWith("team", "writer", "writer-run");
    expect(mocks.cleanupPrivateAgentSessionDirectory).toHaveBeenCalledWith("team", "writer", "writer-run");
    expect(mocks.occupyLifecycleTombstone).not.toHaveBeenCalled();
  });

  it("fences the exact spawned pane and retains recovery artifacts when termination cannot be proven", async () => {
    const admitted = writer();
    mocks.readConfig.mockImplementation(async () => ({ members: [admitted] }));
    mocks.updateMember.mockRejectedValueOnce(new Error("update failed"));
    const terminal = {
      spawn: vi.fn(() => "%writer"),
      kill: vi.fn(),
      isAlive: vi.fn(() => true),
    };
    const onWriterInactive = vi.fn();
    const runtime = createWriteAgentRuntime({
      terminal,
      onWriterInactive,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    await expect(runtime.startWriteAgent("team", admitted, "implement the task")).rejects.toThrow(
      "Failed to spawn background tmux screen: Error: update failed",
    );

    expect(terminal.kill).toHaveBeenCalledWith("%writer");
    expect(terminal.isAlive).toHaveBeenCalledWith("%writer");
    expect(mocks.occupyLifecycleTombstone).toHaveBeenCalledWith(expect.objectContaining({
      team: "team",
      agent: "writer",
      runId: "writer-run",
      role: "write",
      phase: "cleanup_failed",
      extensionInstanceId: "extension-instance",
    }));
    expect(mocks.updateLifecycleTombstone).toHaveBeenCalledWith("writer-run", expect.objectContaining({
      phase: "cleanup_failed",
      error: expect.stringContaining("%writer"),
    }));
    expect(onWriterInactive).not.toHaveBeenCalled();
    expect(mocks.removeInboxMessagesByOperationUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.removeMemberMatchingRun).not.toHaveBeenCalled();
    expect(mocks.cleanupPrivateAgentSessionDirectory).not.toHaveBeenCalled();
  });

  it("uses Pi's resumable session store only after an explicit opt-in", async () => {
    mocks.showInResume = true;
    const terminal = { spawn: vi.fn(() => "%writer") };
    const runtime = createWriteAgentRuntime({
      terminal,
      createResourcePlan: async () => ({
        selectionMode: "explicit",
        extensionPaths: [],
        selfExtensionPath: "self.ts",
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: "/trusted/project", projectTrusted: true },
      }),
    });

    await runtime.startWriteAgent("team", writer(), "implement the task");

    expect(mocks.buildCommand.mock.calls[0]?.[6]).toBeUndefined();
    const spawn = (terminal.spawn.mock.calls as any[][])[0]?.[0];
    expect(spawn.command).not.toContain("--session-dir");
  });
});
