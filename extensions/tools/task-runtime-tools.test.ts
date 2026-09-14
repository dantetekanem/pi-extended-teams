import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyAssignedChecks } from "../../src/results/check-policy";
import { createAgentStatusTool } from "./agent-status-tool";
import * as paths from "../../src/utils/paths.js";
import { registerTaskRuntimeTools, type TaskRuntimeToolsOptions } from "./task-runtime-tools.js";
import { VerificationController } from "../../src/results/verification-controller";
import * as lifecycleTombstones from "../../src/utils/lifecycle-tombstone";
import { createLifecycleRuntime } from "../team/lifecycle";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as reportEvents from "../../src/utils/report-events.js";
import { createReportResult } from "../../src/results/report-result";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";

let root = "";

function registerTools(isTeammate: boolean, shutdownTeammate?: TaskRuntimeToolsOptions["shutdownTeammate"], cancelQueuedAgent?: TaskRuntimeToolsOptions["cancelQueuedAgent"]) {
  const tools = new Map<string, any>();
  registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
    isTeammate,
    terminal: null,
    runningReadAgents: new Map(),
    readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    interruptTeammate: vi.fn(async (agentName: string) => ({
      status: "no_command" as const,
      agentName,
      message: `Agent ${agentName} has no running tool command to interrupt.`,
    })),
    shutdownTeammate: shutdownTeammate ?? vi.fn(async () => ({
      status: "settled" as const,
      reason: "quit" as const,
      extensionShutdown: "no_handlers" as const,
      abort: "unavailable" as const,
      delivery: "settled" as const,
      dispose: "settled" as const,
      cancelledDeliveries: 0,
      persistenceClosed: true,
      finalized: true,
      removedMember: true,
      releasedClaims: [],
    })),
    getTeamName: () => "team",
    cancelQueuedAgent,
  });
  return tools;
}

describe("task runtime tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-runtime-tools-"));
    vi.spyOn(paths, "teamDir").mockImplementation(teamName => path.join(root, String(teamName)));
    vi.spyOn(paths, "configPath").mockImplementation(teamName => path.join(root, String(teamName), "config.json"));
    vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName, agentName) => path.join(root, String(teamName), "runtime", `${agentName}.json`));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => {
      return path.join(root, String(teamName), "lifecycle", "quarantine", `${String(agentName)}.json`);
    });
    vi.spyOn(paths, "reportEventsPath").mockImplementation((teamName) => {
      return path.join(root, String(teamName), "reports.json");
    });
    vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "agent", "reports"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps process-control tools lead-only while leaving diagnostics available", () => {
    const leadTools = registerTools(false);
    const teammateTools = registerTools(true);

    expect(leadTools.has("interrupt_teammate")).toBe(true);
    expect(leadTools.has("stop_teammate")).toBe(true);
    expect(leadTools.has("check_teammate")).toBe(true);
    expect(teammateTools.has("interrupt_teammate")).toBe(false);
    expect(teammateTools.has("stop_teammate")).toBe(false);
    expect(teammateTools.has("check_teammate")).toBe(true);
    expect(leadTools.get("check_teammate").description).toContain("get_agent_status");
    expect(leadTools.get("check_teammate").description).toContain("may clean up");
  });

  it("waits for durable grouped cancellation before acknowledging a queued stop", async () => {
    let complete!: (value: boolean) => void;
    const cancellation = new Promise<boolean>(resolve => { complete = resolve; });
    const tool = registerTools(false, undefined, () => cancellation).get("stop_teammate");
    let acknowledged = false;
    const stopping = tool.execute("stop", { agent_name: "queued" }).then((result: any) => { acknowledged = true; return result; });
    await Promise.resolve();
    const acknowledgedEarly = acknowledged;
    complete(true);
    const result = await stopping;
    expect(acknowledgedEarly).toBe(false);
    expect(result.details).toMatchObject({ stopped: true, queued: true });
  });

  it("retrieves current-source verification and full check references without rewriting historical results", async () => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "tested");
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: 0, leadAgentId: "lead", leadSessionId: "session", members: [],
    });
    const result = createReportResult("team", "reader", "run", { outcome: "succeeded" });
    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData(data: Buffer): void }) => {
      options.onData(Buffer.from("full observed output")); return { exitCode: 0 };
    });
    result.verification = (await verifyAssignedChecks("team", result, cwd,
      [{ name: "tests", command: "assigned", timeoutSeconds: 2 }], { loadOperations: async () => ({ exec }) })).verification;
    await reportEvents.appendTeamReportEvent("team", { agentName: "reader", status: "completed", source: "read-agent", report: "Full report", result });
    const status = createAgentStatusTool({ getTeamName: () => "team", runningReadAgents: new Map(),
      readAgentKey: (team, name) => `${team}:${name}`, terminal: null, listQueuedAgents: () => [] });
    expect((await status.execute("before", {})).details.statuses[0].verification).toBe("passed");
    fs.writeFileSync(path.join(cwd, "input.ts"), "changed after verification");
    expect((await status.execute("after", {})).details.statuses[0].verification).toBe("stale");
    const recovered = await registerTools(false).get("check_teammate").execute("recover", { agent_name: "reader" });
    expect(recovered.details.completedReport.result.verification.state).toBe("stale");
    const check = recovered.details.completedReport.checks[0];
    expect(recovered.content[0].text).toContain(check.logPath);
    expect(fs.readFileSync(check.logPath, "utf8")).toBe("full observed output");
    expect(JSON.parse(fs.readFileSync(paths.reportEventsPath("team"), "utf8"))[0].result.verification.state).toBe("passed");
    expect(exec).toHaveBeenCalledOnce();
  });

  async function repairFixture(state: "running" | "exhausted" | "uncertain") {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "tested");
    const result = createReportResult("team", "reader", "run", { outcome: "succeeded" });
    const member: Member = { agentId: "reader@team", name: "reader", agentType: "teammate", role: "write", cwd,
      lifecycleRunId: "run", joinedAt: 0, tmuxPaneId: "", subscriptions: [], isActive: false,
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repairPolicy: { maxAttempts: 1 } };
    const controller = new VerificationController({ teamName: "team", result, cwd, checks: member.assignedChecks, repair: member.repairPolicy });
    const exec = vi.fn(async (_command: string, _cwd: string, options: { onData(data: Buffer): void }) => {
      options.onData(Buffer.from("observed check output")); return { exitCode: state === "running" ? 0 : 1 };
    });
    const operations = { loadOperations: async () => ({ exec }) };
    let decision = await controller.verify("initial", operations);
    if (state === "exhausted") decision = await controller.verify("repair", operations);
    else if (state === "uncertain") {
      const unresolved = { ...result, verification: { ...decision.result.verification, error: "Repair reservation was not durable" } };
      await reportEvents.appendTeamReportEvent("team", { agentName: "reader", status: "failed", source: "read-agent", report: "Recovery report", result: unresolved });
    } else {
      const ledger = JSON.parse(fs.readFileSync(controller.journalPath, "utf8"));
      ledger.stages[0].state = "running";
      fs.writeFileSync(controller.journalPath, JSON.stringify(ledger));
    }
    return { member, decision, controller, exec };
  }

  it("exposes an effective repair blocker and recovers full evidence with or without the roster", async () => {
    const fixture = await repairFixture("exhausted");
    const config = { name: "team", description: "", createdAt: 0, leadAgentId: "lead", leadSessionId: "session", members: [] as Member[] };
    const roster = vi.spyOn(teams, "readConfig").mockResolvedValue(config);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    await reportEvents.appendTeamReportEvent("team", { agentName: "reader", status: "completed", source: "read-agent", report: "Full report", result: fixture.decision.result });
    const status = createAgentStatusTool({ getTeamName: () => "team", runningReadAgents: new Map(),
      readAgentKey: (team, name) => `${team}:${name}`, terminal: null, listQueuedAgents: () => [] });
    for (const members of [[], [fixture.member]]) {
      roster.mockResolvedValue({ ...config, members });
      const observed = await status.execute("status", {});
      expect(observed.details.statuses[0]).toMatchObject({ outcome: "succeeded", effectiveOutcome: "blocked", verification: "failed",
        repair: { state: "exhausted", attemptsUsed: 1, maxAttempts: 1, journalPath: fixture.controller.journalPath }, acceptance: "pending" });
      expect(observed.content[0].text).toContain("effective task: blocked");
    }
    roster.mockResolvedValue(config);
    const recovered = await registerTools(false).get("check_teammate").execute("recover", { agent_name: "reader" });
    expect(recovered.details.completedReport.result).toMatchObject({ outcome: "succeeded", repair: { state: "exhausted", outcome: "blocked" } });
    expect(recovered.content[0].text).toContain("effective task: blocked");
    expect(recovered.content[0].text).toContain(fixture.decision.checks[0].logPath);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["check_teammate", "running"], ["stop_teammate", "running"],
    ["check_teammate", "uncertain"], ["stop_teammate", "uncertain"],
  ] as const)("keeps orphaned repair fenced during %s with %s ownership", async (toolName, ownership) => {
    const fixture = await repairFixture(ownership);
    fs.writeFileSync(paths.configPath("team"), JSON.stringify({ name: "team", description: "", createdAt: 0,
      leadAgentId: "lead", leadSessionId: "session", members: [fixture.member] }));
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);
    const release = vi.fn(async () => [] as string[]);
    const lifecycle = createLifecycleRuntime({ isTeammate: false, terminal: null, runningReadAgents: new Map(),
      readAgentKey: (team, name) => `${team}:${name}`, isCurrentReadAgentRun: () => true, renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: release, drainWriteQueue: async () => {}, getSessionCwd: () => fixture.member.cwd, getTeamName: () => "team" });
    const shutdown = vi.fn(lifecycle.shutdownTeammate);
    const status = createAgentStatusTool({ getTeamName: () => "team", runningReadAgents: new Map(),
      readAgentKey: (team, name) => `${team}:${name}`, terminal: null, listQueuedAgents: () => [] });
    const snapshot = await status.execute("status", {});
    expect(snapshot.details.statuses[0]).toMatchObject({ verification: "pending", effectiveOutcome: "blocked", repair: { state: "pending" } });
    const diagnosed = await registerTools(false, shutdown).get(toolName).execute("diagnose", { agent_name: "reader" });
    expect(diagnosed.details.teardown).toMatchObject({ status: "cleanup_failed", finalized: false, removedMember: false, releasedClaims: [] });
    expect(diagnosed.content[0].text).toContain(fixture.controller.journalPath);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(fixture.exec).toHaveBeenCalledOnce();
  });

  it.each(["run", "replacement"])("recovers only repair evidence belonging to the remaining %s fence", async runId => {
    const fixture = await repairFixture("uncertain");
    vi.spyOn(teams, "readConfig").mockResolvedValue({ name: "team", description: "", createdAt: 0,
      leadAgentId: "lead", leadSessionId: "session", members: [] });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(lifecycleTombstones, "readLifecycleTombstone").mockResolvedValue({ status: "occupied", tombstone: {
      version: 1, team: "team", agent: "reader", runId, role: "write", reason: "quit", phase: "cleanup_failed",
      ownerPid: 123, extensionInstanceId: "extension", timestamps: { createdAt: 0, updatedAt: 0 },
    } });
    const recovered = await registerTools(false).get("check_teammate").execute("recover", { agent_name: "reader" });
    expect(recovered.details).toMatchObject({ health: "quarantined", removedMember: false, tombstone: { runId } });
    if (runId === "run") {
      expect(recovered.details.completedReport.result).toMatchObject({ runId, repair: { state: "pending" } });
      expect(recovered.content[0].text).toContain(fixture.controller.journalPath);
      expect(recovered.content[0].text).toContain(fixture.decision.checks[0].logPath);
      expect(recovered.content[0].text).toContain(recovered.details.completedReport.reportPath);
    } else expect(recovered.details.completedReport).toBeUndefined();
    expect(fixture.exec).toHaveBeenCalledOnce();
  });

  it("cancels accepted queued work before looking for an active process", async () => {
    const tools = new Map<string, any>();
    const cancelQueuedAgent = vi.fn(() => true);
    const shutdownTeammate = vi.fn();
    const readConfig = vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: 0, leadAgentId: "lead", leadSessionId: "session", members: [],
    });
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false, terminal: null, runningReadAgents: new Map(),
      readAgentKey: (team, name) => `${team}:${name}`, cancelQueuedAgent, shutdownTeammate,
      getTeamName: () => "team",
    });
    const result = await tools.get("stop_teammate").execute("stop", { agent_name: "queued" });
    expect(result.details).toMatchObject({ stopped: true, queued: true });
    expect(cancelQueuedAgent).toHaveBeenCalledWith("team", "queued");
    expect(shutdownTeammate).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("renders the shared interruption result without invoking whole-agent teardown", async () => {
    const tools = new Map<string, any>();
    const shutdownTeammate = vi.fn();
    const interruptTeammate = vi.fn(async (agentName: string) => ({
      status: "interrupt_sent" as const,
      agentName,
      agentKind: "write" as const,
      lifecycleRunId: "writer-run",
      mechanism: "tmux-escape" as const,
      message: `Sent Pi's Escape interrupt to writer's running bash command.`,
    }));
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      interruptTeammate,
      shutdownTeammate,
      getTeamName: () => "team",
    });

    const result = await tools.get("interrupt_teammate").execute("interrupt", { agent_name: "writer" });

    expect(interruptTeammate).toHaveBeenCalledWith("writer");
    expect(shutdownTeammate).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: `Sent Pi's Escape interrupt to writer's running bash command.` }]);
    expect(result.details).toMatchObject({
      session: "team",
      status: "interrupt_sent",
      agentName: "writer",
      mechanism: "tmux-escape",
    });
  });

  it("reports timeout quarantine instead of claiming the agent stopped cleanly", async () => {
    const tools = new Map<string, any>();
    const teardown = {
      status: "timed_out" as const,
      reason: "quit" as const,
      extensionShutdown: "emitted" as const,
      abort: "timed_out" as const,
      delivery: "timed_out" as const,
      dispose: "deferred" as const,
      cancelledDeliveries: 1,
      persistenceClosed: true,
      finalized: false,
      removedMember: false,
      releasedClaims: [],
    };
    const readConfig = vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [{
        agentId: "reader@team",
        name: "reader",
        agentType: "teammate",
        role: "read",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: process.cwd(),
        subscriptions: [],
      }],
    });
    try {
      registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
        isTeammate: false,
        terminal: null,
        runningReadAgents: new Map(),
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        shutdownTeammate: vi.fn(async () => teardown),
        getTeamName: () => "team",
      });

      const result = await tools.get("stop_teammate").execute("stop", { agent_name: "reader" });
      expect(result.content[0].text).toContain("inactive but quarantined");
      expect(result.content[0].text).not.toContain("Stopped agent");
      expect(result.details).toMatchObject({ stopped: false, quarantined: true, teardown });
    } finally {
      readConfig.mockRestore();
    }
  });

  it.each([undefined, "blocked"] as const)("limits post-roster report recovery to the lead with outcome %s", async outcome => {
    const leadTools = registerTools(false);
    const teammateTools = registerTools(true);
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: Date.now(), leadAgentId: "lead", leadSessionId: "session", members: [],
    });
    const structured = outcome ? createReportResult("team", "finished-reader", "run-1", { outcome }) : undefined;
    await reportEvents.appendTeamReportEvent("team", {
      result: structured,
      agentName: "finished-reader",
      role: "read",
      status: "completed",
      report: "Durable completed report",
      summary: "Done",
      createdAt: Date.now(),
      source: "read-agent",
      metadata: { reportSource: "persisted-report_and_exit", recoverySessionFile: "/tmp/finished-reader.jsonl" },
    });

    const result = await leadTools.get("check_teammate").execute("check", { agent_name: "finished-reader" });

    expect(result.content[0].text).toContain("Recovered its latest persisted completed report");
    expect(result.content[0].text).toContain("Durable completed report");
    expect(result.content[0].text).toContain("/tmp/finished-reader.jsonl");
    expect(result.content[0].text).toContain(path.join(root, "team", "reports.json"));
    expect(result.details).toMatchObject({
      alive: false,
      health: "completed",
      removedMember: true,
      completedReport: { agentName: "finished-reader", report: "Durable completed report" },
    });

    expect(result.details.completedReport.result).toEqual(structured);
    const listReports = vi.spyOn(reportEvents, "listTeamReportEvents");
    await expect(teammateTools.get("check_teammate").execute("check", { agent_name: "finished-reader" }))
      .rejects.toThrow("Agent finished-reader not found");
    expect(listReports).not.toHaveBeenCalled();
  });

  it("uses lifecycle cleanup proof for a settled dead teammate", async () => {
    const tools = new Map<string, any>();
    const member: Member = {
      agentId: "dead@team",
      name: "dead",
      agentType: "teammate",
      role: "write",
      joinedAt: Date.now() - 60_000,
      tmuxPaneId: "%dead",
      cwd: process.cwd(),
      subscriptions: [],
      isActive: true,
    };
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: Date.now(), leadAgentId: "lead", leadSessionId: "session", members: [member],
    });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);
    const shutdownTeammate = vi.fn(async () => ({
      status: "settled" as const,
      reason: "quit" as const,
      extensionShutdown: "no_handlers" as const,
      abort: "unavailable" as const,
      delivery: "settled" as const,
      dispose: "settled" as const,
      cancelledDeliveries: 0,
      persistenceClosed: true,
      finalized: true,
      removedMember: true,
      releasedClaims: ["src/dead.ts"],
    }));
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false,
      terminal: { isAlive: vi.fn(() => false) },
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      shutdownTeammate,
      getTeamName: () => "team",
    });

    const result = await tools.get("check_teammate").execute("check", { agent_name: "dead" });

    expect(shutdownTeammate).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      alive: false,
      health: "dead",
      removedMember: true,
      releasedClaims: ["src/dead.ts"],
    });
  });

  it.each([
    ["stopping", "stopping"],
    ["quarantined", "quarantined"],
    ["persistence_failed", "persistence-failed"],
  ] as const)("gives teardown state %s precedence and skips duplicate cleanup", async (teardownState, expectedHealth) => {
    const tools = new Map<string, any>();
    const member: Member = {
      agentId: "reader@team", name: "reader", agentType: "teammate", role: "read",
      joinedAt: Date.now(), tmuxPaneId: "", cwd: process.cwd(), subscriptions: [], isActive: false,
    };
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: Date.now(), leadAgentId: "lead", leadSessionId: "session", members: [member],
    });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "team", agentName: "reader", ready: true, startedAt: Date.now(), lastHeartbeatAt: Date.now(), currentAction: "working",
    });
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);
    const state: RunningReadAgent = {
      runId: "run", name: "reader", teamName: "team", startedAt: Date.now(), tokensUsed: 10,
      status: "working", recentEvents: [], lastActivityAt: Date.now(), teardownState,
    };
    const shutdownTeammate = vi.fn();
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map([["team:reader", state]]),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      shutdownTeammate,
      getTeamName: () => "team",
    });

    const result = await tools.get("check_teammate").execute("check", { agent_name: "reader" });

    expect(result.details).toMatchObject({ alive: false, health: expectedHealth, agentLoopReady: false, removedMember: false });
    expect(result.content[0].text).toContain(expectedHealth);
    expect(shutdownTeammate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "fresh runtime heartbeat", isActive: true, heartbeatAge: 0, paneAlive: false, expectedAlive: true, expectedHealth: "healthy" },
    { label: "stale ready file", isActive: true, heartbeatAge: runtime.HEARTBEAT_STALE_MS + 1, paneAlive: false, expectedAlive: false, expectedHealth: "dead" },
    { label: "inactive stale ready file", isActive: false, heartbeatAge: runtime.HEARTBEAT_STALE_MS + 1, paneAlive: false, expectedAlive: false, expectedHealth: "dead" },
    { label: "live legacy pane", isActive: true, heartbeatAge: runtime.HEARTBEAT_STALE_MS + 1, paneAlive: true, expectedAlive: true, expectedHealth: "idle" },
    { label: "inactive legacy pane", isActive: false, heartbeatAge: 0, paneAlive: true, expectedAlive: false, expectedHealth: "dead" },
  ])("classifies legacy diagnostics coherently: $label", async ({ isActive, heartbeatAge, paneAlive, expectedAlive, expectedHealth }) => {
    const tools = new Map<string, any>();
    const now = Date.now();
    const member: Member = {
      agentId: "legacy@team", name: "legacy", agentType: "teammate", role: "write",
      joinedAt: now - 60_000, tmuxPaneId: "%legacy", cwd: process.cwd(), subscriptions: [], isActive,
    };
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: now, leadAgentId: "lead", leadSessionId: "session", members: [member],
    });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "team", agentName: "legacy", ready: true, startedAt: now - 60_000, lastHeartbeatAt: now - heartbeatAge,
    });
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);
    const shutdownTeammate = vi.fn(async () => ({
      status: "settled" as const, reason: "quit" as const, extensionShutdown: "no_handlers" as const,
      abort: "unavailable" as const, delivery: "settled" as const, dispose: "settled" as const,
      cancelledDeliveries: 0, persistenceClosed: true, finalized: true, removedMember: true, releasedClaims: [],
    }));
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false,
      terminal: { isAlive: vi.fn(() => paneAlive) },
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      shutdownTeammate,
      getTeamName: () => "team",
    });

    const result = await tools.get("check_teammate").execute("check", { agent_name: "legacy" });

    expect(result.details.alive).toBe(expectedAlive);
    expect(result.details.health).toBe(expectedHealth);
    expect(shutdownTeammate).toHaveBeenCalledTimes(expectedAlive ? 0 : 1);
  });

  it.each([
    { status: "timed_out" as const, expectedHealth: "quarantined" },
    { status: "persistence_failed" as const, expectedHealth: "persistence-failed" },
    { status: "cleanup_failed" as const, expectedHealth: "cleanup-blocked" },
  ])("maps lifecycle $status without destructive fallback", async ({ status, expectedHealth }) => {
    const tools = new Map<string, any>();
    const member: Member = {
      agentId: "dead@team", name: "dead", agentType: "teammate", role: "read",
      joinedAt: Date.now(), tmuxPaneId: "", cwd: process.cwd(), subscriptions: [], isActive: false,
    };
    vi.spyOn(teams, "readConfig").mockResolvedValue({
      name: "team", description: "", createdAt: Date.now(), leadAgentId: "lead", leadSessionId: "session", members: [member],
    });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);
    const shutdownTeammate = vi.fn(async () => ({
      status,
      reason: "quit" as const,
      extensionShutdown: "no_handlers" as const,
      abort: "unavailable" as const,
      delivery: "settled" as const,
      dispose: "deferred" as const,
      cancelledDeliveries: 0,
      persistenceClosed: status !== "persistence_failed",
      finalized: false,
      removedMember: false,
      releasedClaims: ["src/already-released.ts"],
      error: "blocked cleanup",
    }));
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      isTeammate: false,
      terminal: null,
      runningReadAgents: new Map(),
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      shutdownTeammate,
      getTeamName: () => "team",
    });

    const result = await tools.get("check_teammate").execute("check", { agent_name: "dead" });

    expect(shutdownTeammate).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      alive: false,
      health: expectedHealth,
      removedMember: false,
      releasedClaims: ["src/already-released.ts"],
      error: "blocked cleanup",
    });
  });
});
