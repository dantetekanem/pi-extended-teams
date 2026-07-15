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
  withLifecycleTombstoneLock: vi.fn(async (_teamName: string, _agentName: string, fn: Function) => fn({
    read: () => ({ status: "absent" }),
  })),
  deleteRuntimeStatusUnderLifecycleLock: vi.fn(async () => true),
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
  ) => `pi ${projectTrusted ? "--approve" : "--no-approve"} --no-extensions --extension 'self.ts' --extension '/external/$safe.ts'`),
  favoriteLevel: {
    slot: "writing-hard",
    role: "write",
    model: "provider/model",
    thinking: "xhigh",
  },
}));

vi.mock("../../src/utils/settings", () => ({
  loadSettings: vi.fn(() => ({ debug: { enabled: false } })),
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
vi.mock("../team/roster", () => ({ countWriteMembers: vi.fn(async () => 0) }));
vi.mock("../../src/utils/lifecycle-tombstone", () => ({
  readLifecycleTombstone: vi.fn(async () => ({ status: "absent" })),
  withLifecycleTombstoneLock: mocks.withLifecycleTombstoneLock,
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
    mocks.writeTeamsDebugEvent.mockImplementation(async () => {});
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

  it("does not let an R1 spawn rollback remove an R2 replacement admitted during awaited debug logging", async () => {
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
    const runtime = createWriteAgentRuntime({
      terminal: { spawn: vi.fn(() => { throw new Error("spawn failed"); }) },
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

    const launch = runtime.startWriteAgent("team", writer(), "implement the task");
    await failureLogged;
    replacementAdmitted = true;
    releaseFailureLog();

    await expect(launch).rejects.toThrow("Failed to spawn background tmux screen: Error: spawn failed");
    expect(mocks.withLifecycleTombstoneLock).toHaveBeenCalledWith("team", "writer", expect.any(Function));
    expect(mocks.deleteRuntimeStatusUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.removeMemberMatchingRun).not.toHaveBeenCalled();
    expect(onWriterInactive).not.toHaveBeenCalled();
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
    expect(mocks.buildCommand.mock.calls[0]).toHaveLength(6);
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/trusted/project",
      command: expect.stringContaining("--approve"),
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
});
