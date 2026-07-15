import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { registerCoordinationTools } from "./coordination-tools.js";
import { registerExtensionEvents } from "../events/register-events.js";
import * as paths from "../../src/utils/paths.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as reportEvents from "../../src/utils/report-events.js";
import type { Member, TeamConfig } from "../../src/utils/models.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";

let root: string;
let teamsRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: string, agentName: string) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: string, agentName: string) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: string, agentName: string) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function member(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@exit`,
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

describe("coordination tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-coordination-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("read_inbox defaults to returning only unread messages", async () => {
    const teamName = "inbox-team";
    await messaging.sendPlainMessage(teamName, "reader", "team-lead", "Already handled", "old");
    await messaging.readInbox(teamName, "team-lead", true, true);
    await messaging.sendPlainMessage(teamName, "writer", "team-lead", "New report", "new");
    const tools = new Map<string, any>();
    const renderLeadInboxStatus = vi.fn(async () => {});
    const resetLeadWakeNotifiedCount = vi.fn();

    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName: "team-lead",
      isTeammate: false,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus,
      resetLeadWakeNotifiedCount,
    });

    const result = await tools.get("read_inbox").execute(
      "read",
      {},
      new AbortController().signal,
      vi.fn(),
      {}
    );

    expect(result.details.messages).toHaveLength(1);
    expect(result.details.messages[0]).toMatchObject({ text: "New report", read: true });
    expect(result.content[0].text).not.toContain("Already handled");
    expect(resetLeadWakeNotifiedCount).toHaveBeenCalledOnce();
    expect(renderLeadInboxStatus).toHaveBeenCalledOnce();
  });

  it("send_message fails when the recipient subagent is not running", async () => {
    const teamName = "message-team";
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [member("team-lead")],
    });
    const tools = new Map<string, any>();

    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName: "team-lead",
      isTeammate: false,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    await expect(tools.get("send_message").execute("send", {
      recipient: "staged-browser-designer",
      content: "Continue the design.",
    })).rejects.toThrow("Cannot send message to staged-browser-designer: agent is not running.");

    expect(await messaging.readInbox(teamName, "staged-browser-designer", false, false)).toEqual([]);
  });

  it("delivers lead scope updates directly to an active in-process agent", async () => {
    const teamName = "message-team";
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member("reader", { role: "read", tmuxPaneId: "" }),
      ],
    });
    const tools = new Map<string, any>();
    const deliverMessageToActiveAgent = vi.fn(async () => true);

    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName: "team-lead",
      isTeammate: false,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
      deliverMessageToActiveAgent,
    });

    const result = await tools.get("send_message").execute("send", {
      recipient: "reader",
      content: "Include the new screenshot in your audit.",
    });

    expect(deliverMessageToActiveAgent).toHaveBeenCalledWith(
      teamName,
      "reader",
      "Include the new screenshot in your audit."
    );
    expect(result.details.delivery).toBe("active-session");
    expect(await messaging.readInbox(teamName, "reader", false, false)).toEqual([]);
  });

  it("keeps trailing report events fenced, then verifies matching cleanup and clears the tombstone last on shutdown", async () => {
    vi.useFakeTimers();
    const teamName = "exit-team";
    const agentName = "writer";
    const runId = "writer-run";
    vi.stubEnv("PI_LIFECYCLE_RUN_ID", runId);
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member(agentName, { lifecycleRunId: runId, tmuxPaneId: "%writer", model: "provider/model", thinking: "high", modelSlot: "writing-hard" }),
      ],
    });
    const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
    fs.writeFileSync(pidFile, String(process.pid));
    await runtime.writeRuntimeStatus(teamName, agentName, runId, {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      ready: true,
    });

    const sendSpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);
    const reportEventSpy = vi.spyOn(reportEvents, "appendTeamReportEvent").mockResolvedValue({} as any);
    let notifyClaimReleaseStarted!: () => void;
    const claimReleaseStarted = new Promise<void>((resolve) => { notifyClaimReleaseStarted = resolve; });
    let finishClaimRelease!: () => void;
    const releaseAllClaimsForAgent = vi.fn(() => {
      notifyClaimReleaseStarted();
      return new Promise<string[]>((resolve) => { finishClaimRelease = () => resolve([]); });
    });
    const drainWriteQueue = vi.fn(async () => {});
    const terminal = { kill: vi.fn(), setTitle: vi.fn() };
    const ctx = {
      cwd: root,
      shutdown: vi.fn(),
      isIdle: () => true,
      ui: { notify: vi.fn(), setTitle: vi.fn() },
      sessionManager: { getBranch: vi.fn(() => []) },
    };
    const tools = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const pi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((eventName: string, handler: Function) => {
        handlers.set(eventName, [...(handlers.get(eventName) || []), handler]);
      }),
    };
    registerExtensionEvents(pi, {
      isTeammate: true,
      agentName,
      getTeamName: () => teamName,
      setSessionCtx: vi.fn(),
      terminal,
      quietTrigger: vi.fn(),
      startLeadInboxPolling: vi.fn(),
      startLeadWatchdog: vi.fn(),
      buildRoster: vi.fn(async () => ({ teamName, members: [] })),
      formatRosterForPrompt: vi.fn(() => "Roster: empty"),
    });

    registerCoordinationTools(pi, {
      agentName,
      isTeammate: true,
      terminal,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent,
      drainWriteQueue,
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    const report = tools.get("report_and_exit").execute(
      "report",
      { content: "done", summary: "Done" },
      new AbortController().signal,
      vi.fn(),
      ctx
    );
    await claimReleaseStarted;
    const stoppingMember = JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")).members
      .find((item: Member) => item.name === agentName);
    expect(stoppingMember?.isActive).toBe(false);

    const leadTools = new Map<string, any>();
    registerCoordinationTools({ registerTool: (tool: any) => leadTools.set(tool.name, tool) }, {
      agentName: "team-lead",
      isTeammate: false,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });
    await expect(leadTools.get("send_message").execute("send", {
      recipient: agentName,
      content: "One more requirement.",
    })).rejects.toThrow("lifecycle-quarantined");
    expect(sendSpy).toHaveBeenCalledTimes(1);

    finishClaimRelease();
    const result = await report;

    expect(sendSpy).toHaveBeenCalledWith(
      teamName,
      agentName,
      "team-lead",
      "done",
      "Done",
      undefined,
      { metadata: expect.objectContaining({ modelSlot: "write-system" }) }
    );
    expect(reportEventSpy).toHaveBeenCalledWith(teamName, expect.objectContaining({
      modelSlot: "write-system",
      metadata: { modelSlot: "write-system" },
    }));
    expect(JSON.stringify({ inbox: sendSpy.mock.calls, events: reportEventSpy.mock.calls })).not.toContain("writing-hard");
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(await runtime.readRuntimeStatus(teamName, agentName)).toMatchObject({ lifecycleRunId: runId, ready: true });
    expect(releaseAllClaimsForAgent).toHaveBeenCalledWith(teamName, agentName);
    expect(drainWriteQueue).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")).members.map((item: Member) => item.name)).toEqual(["team-lead", agentName]);
    expect(result.content[0].text).toContain("Final report sent.");

    for (const handler of handlers.get("tool_execution_end") || []) await handler({ toolName: "report_and_exit" }, ctx);
    for (const handler of handlers.get("message_end") || []) await handler({ message: { role: "assistant", content: [] } }, ctx);
    for (const handler of handlers.get("turn_end") || []) await handler({}, ctx);
    expect(await runtime.readRuntimeStatus(teamName, agentName)).toMatchObject({ lifecycleRunId: runId, ready: true });

    for (const handler of handlers.get("session_shutdown") || []) await handler({}, ctx);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(await runtime.readRuntimeStatus(teamName, agentName)).toBeNull();
    expect(JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")).members.map((item: Member) => item.name)).toEqual(["team-lead"]);
    await expect(readLifecycleTombstone(teamName, agentName)).resolves.toEqual({ status: "absent" });
    expect(drainWriteQueue).toHaveBeenCalledWith(teamName);

    await vi.runOnlyPendingTimersAsync();
    expect(terminal.kill).not.toHaveBeenCalled();
    expect(ctx.shutdown).toHaveBeenCalled();
  });

  it("rejects an R1 report when the roster already belongs to R2 without fencing or changing R2", async () => {
    const teamName = "stale-report-team";
    const agentName = "writer";
    vi.stubEnv("PI_LIFECYCLE_RUN_ID", "run-r1");
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member(agentName, { lifecycleRunId: "run-r2", tmuxPaneId: "%r2", isActive: true }),
      ],
    });
    const tools = new Map<string, any>();
    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName,
      isTeammate: true,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    await expect(tools.get("report_and_exit").execute(
      "report",
      { content: "stale R1 report" },
      new AbortController().signal,
      vi.fn(),
      { cwd: root, shutdown: vi.fn() },
    )).rejects.toThrow("Refusing stale report run run-r1");
    expect((await runtime.readRuntimeStatus(teamName, agentName))).toBeNull();
    expect((JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")) as TeamConfig).members[1]).toMatchObject({
      lifecycleRunId: "run-r2",
      isActive: true,
    });
    await expect(readLifecycleTombstone(teamName, agentName)).resolves.toEqual({ status: "absent" });
  });

  it("retains a cleanup_failed fence and never removes an R2 replacement during R1 shutdown", async () => {
    vi.useFakeTimers();
    const teamName = "replacement-exit-team";
    const agentName = "writer";
    const runId = "run-r1";
    vi.stubEnv("PI_LIFECYCLE_RUN_ID", runId);
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member(agentName, { lifecycleRunId: runId, tmuxPaneId: "%r1" }),
      ],
    });
    await runtime.writeRuntimeStatus(teamName, agentName, runId, {
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      ready: true,
    });
    const tools = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    registerCoordinationTools({
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (eventName: string, handler: Function) => {
        handlers.set(eventName, [...(handlers.get(eventName) || []), handler]);
      },
    }, {
      agentName,
      isTeammate: true,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    await tools.get("report_and_exit").execute(
      "report",
      { content: "R1 done", summary: "Done" },
      new AbortController().signal,
      vi.fn(),
      { cwd: root, shutdown: vi.fn() },
    );

    const replacement = member(agentName, {
      lifecycleRunId: "run-r2",
      tmuxPaneId: "%r2",
      joinedAt: Date.now() + 1,
      isActive: true,
    });
    const config = JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")) as TeamConfig;
    config.members = [config.members[0], replacement];
    fs.writeFileSync(paths.configPath(teamName), JSON.stringify(config, null, 2));

    for (const handler of handlers.get("session_shutdown") || []) await handler({}, {});
    await expect(readLifecycleTombstone(teamName, agentName)).resolves.toMatchObject({
      status: "occupied",
      tombstone: {
        runId,
        phase: "cleanup_failed",
        error: expect.stringContaining("replacement run run-r2"),
      },
    });
    expect((await runtime.readRuntimeStatus(teamName, agentName))?.lifecycleRunId).toBe(runId);
    expect((JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")) as TeamConfig).members[1]).toMatchObject({
      lifecycleRunId: "run-r2",
      tmuxPaneId: "%r2",
      isActive: true,
    });

    for (const handler of handlers.get("session_shutdown") || []) await handler({}, {});
    await expect(readLifecycleTombstone(teamName, agentName)).resolves.toMatchObject({
      status: "occupied",
      tombstone: { runId, phase: "cleanup_failed" },
    });
  });

  it("retains the R1 fence, runtime, and member when PID cleanup is denied during shutdown", async () => {
    const teamName = "pid-cleanup-failure-team";
    const agentName = "writer";
    const runId = "run-r1";
    vi.stubEnv("PI_LIFECYCLE_RUN_ID", runId);
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member(agentName, { lifecycleRunId: runId, tmuxPaneId: "%r1" }),
      ],
    });
    const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
    fs.writeFileSync(pidFile, String(process.pid));
    await runtime.writeRuntimeStatus(teamName, agentName, runId, {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      ready: true,
    });

    const tools = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const drainWriteQueue = vi.fn(async () => {});
    registerCoordinationTools({
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (eventName: string, handler: Function) => {
        handlers.set(eventName, [...(handlers.get(eventName) || []), handler]);
      },
    }, {
      agentName,
      isTeammate: true,
      terminal: undefined,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue,
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    await tools.get("report_and_exit").execute(
      "report",
      { content: "R1 done", summary: "Done" },
      new AbortController().signal,
      vi.fn(),
      { cwd: root, shutdown: vi.fn() },
    );

    const unlinkSync = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(filePath => {
      if (String(filePath) === pidFile) {
        const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
        throw error;
      }
      return unlinkSync(filePath);
    });
    syncBuiltinESMExports();
    for (const handler of handlers.get("session_shutdown") || []) await handler({}, {});

    expect(fs.existsSync(pidFile)).toBe(true);
    await expect(runtime.readRuntimeStatus(teamName, agentName)).resolves.toMatchObject({ lifecycleRunId: runId, ready: true });
    expect((JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")) as TeamConfig).members[1]).toMatchObject({
      lifecycleRunId: runId,
      isActive: false,
    });
    await expect(readLifecycleTombstone(teamName, agentName)).resolves.toEqual({
      status: "occupied",
      tombstone: expect.objectContaining({
        runId,
        phase: "cleanup_failed",
        error: `Could not remove PID file for ${agentName} run ${runId}.`,
      }),
    });
    expect(drainWriteQueue).not.toHaveBeenCalled();
    await expect(runtime.writeRuntimeStatus(teamName, agentName, runId, { ready: false }))
      .rejects.toThrow(`lifecycle run ${runId} is cleanup_failed`);
  });
});
