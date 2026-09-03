import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import * as reportEvents from "../../src/utils/report-events.js";
import * as lifecycleTombstones from "../../src/utils/lifecycle-tombstone.js";
import type { Member, TeamReportEvent } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";
import { createAgentStatusTool, type QueuedAgentStatus } from "./agent-status-tool.js";

function member(name: string, extras: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@team`,
    name,
    agentType: "teammate",
    role: "read",
    joinedAt: 1_000,
    tmuxPaneId: "",
    cwd: "/tmp",
    subscriptions: [],
    lifecycleRunId: `${name}-run`,
    ...extras,
  };
}

function runningAgent(value: Member, extras: Partial<RunningReadAgent> = {}): RunningReadAgent {
  return {
    runId: value.lifecycleRunId!,
    name: value.name,
    teamName: "team",
    role: value.role,
    startedAt: 1_000,
    tokensUsed: 12,
    status: "working",
    recentEvents: [],
    lastActivityAt: Date.now() - 2_000,
    teardownState: "active",
    ...extras,
  };
}

function report(agentName: string, extras: Partial<TeamReportEvent> = {}): TeamReportEvent {
  return {
    id: `${agentName}-report`,
    teamName: "team",
    agentName,
    role: "read",
    status: "completed",
    report: "Full report",
    summary: "Done",
    createdAt: Date.now() - 1_000,
    source: "read-agent",
    ...extras,
  };
}

function mockRoster(...members: Member[]): void {
  vi.spyOn(teams, "readConfig").mockResolvedValue({
    name: "team", description: "", createdAt: 500, leadAgentId: "lead", leadSessionId: "session", members,
  });
}

function makeTool(
  runningReadAgents: Map<string, RunningReadAgent>,
  queued: QueuedAgentStatus[] = [],
  scope?: { parentName: string; parentRunId: string; parentStartedAt: number },
): any {
  return createAgentStatusTool({
    getTeamName: () => "team",
    runningReadAgents,
    readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
    terminal: null,
    listQueuedAgents: () => queued,
    scope,
  });
}

describe("get_agent_status", () => {
  beforeEach(() => {
    vi.spyOn(lifecycleTombstones, "readLifecycleTombstone").mockResolvedValue({ status: "absent" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns active, queued, and completed state without lifecycle side effects", async () => {
    const active = member("active");
    const writer = member("writer", { role: "write" });
    const nested = member("nested", { helperKind: "read_helper" });
    mockRoster(active, writer, nested);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([
      report("finished"),
      report("writer-finished", { role: "write" }),
      report("nested-finished", { requestedBy: "writer" }),
    ]);
    const runningReadAgents = new Map<string, RunningReadAgent>([
      ["team:active", runningAgent(active, {
        latestProgress: "Tracing delivery",
        progressUpdatedAt: Date.now() - 3_000,
        activeToolName: "read",
      })],
      ["team:writer", runningAgent(writer, { status: "thinking", role: "write", latestProgress: "Editing the claimed file" })],
    ]);
    const queued: QueuedAgentStatus[] = [
      { name: "queued", role: "read", queuedAt: Date.now() - 4_000, queuePosition: 1 },
      { name: "nested-queued", role: "read", queuedAt: Date.now() - 4_000, queuePosition: 2, parentAgentName: "writer" },
    ];
    const tool = makeTool(runningReadAgents, queued);

    const result = await tool.execute("status", {});

    expect(result.details.statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "active", phase: "working", progress: "Tracing delivery", progressAgeMs: expect.any(Number), activeTool: "read" }),
      expect.objectContaining({ name: "writer", role: "write", phase: "thinking", progress: "Editing the claimed file" }),
      expect.objectContaining({ name: "queued", role: "read", phase: "queued", queuePosition: 1 }),
      expect.objectContaining({ name: "finished", phase: "completed", summary: "Done" }),
      expect.objectContaining({ name: "writer-finished", role: "write", phase: "completed", summary: "Done" }),
    ]));
    expect(result.content[0].text).toContain("Use get_agent_status once");
    expect(result.content[0].text).not.toContain("ready");
    expect(result.content[0].text).not.toContain("nested");
  });

  it("prefers a persisted cleanup fence after in-memory lifecycle state is lost", async () => {
    const recovering = member("recovering", { role: "write", isActive: false });
    mockRoster(recovering);
    vi.mocked(lifecycleTombstones.readLifecycleTombstone).mockResolvedValueOnce({
      status: "occupied",
      tombstone: {
        version: 1,
        team: "team",
        agent: "recovering",
        runId: recovering.lifecycleRunId!,
        role: "write",
        reason: "quit",
        phase: "cleanup_failed",
        ownerPid: 123,
        extensionInstanceId: "extension-run",
        timestamps: { createdAt: 1_000, updatedAt: 2_000 },
        error: "report persistence failed",
      },
    });
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "team",
      agentName: "recovering",
      lifecycleRunId: recovering.lifecycleRunId,
      ready: true,
      currentAction: "done",
      lastHeartbeatAt: Date.now(),
    });
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([]);

    const result = await makeTool(new Map()).execute("status", {});

    expect(result.details.statuses).toEqual([
      expect.objectContaining({
        name: "recovering",
        phase: "quarantined",
        error: "report persistence failed",
      }),
    ]);
  });

  it("does not return the same agent as both active and queued during admission", async () => {
    const active = member("reader");
    mockRoster(active);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([]);
    const runningReadAgents = new Map<string, RunningReadAgent>([
      ["team:reader", runningAgent(active)],
    ]);
    const queued: QueuedAgentStatus[] = [
      { name: "reader", role: "read", queuedAt: Date.now() - 1_000, queuePosition: 1 },
    ];

    const result = await makeTool(runningReadAgents, queued).execute("status", {});

    expect(result.details.statuses).toEqual([
      expect.objectContaining({ name: "reader", phase: "working" }),
    ]);
  });

  it("does not join state or runtime telemetry from a different lifecycle run", async () => {
    const writer = member("writer", { role: "write", lifecycleRunId: "writer-old-run" });
    mockRoster(writer);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "team",
      agentName: "writer",
      lifecycleRunId: "writer-new-run",
      ready: true,
      currentAction: "working",
      latestProgress: "New run progress",
      activeToolName: "edit",
      lastHeartbeatAt: Date.now(),
    });
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([]);
    const runningReadAgents = new Map<string, RunningReadAgent>([
      ["team:writer", runningAgent(writer, {
        runId: "writer-new-run",
        status: "thinking",
        latestProgress: "New in-memory run progress",
      })],
    ]);

    const result = await makeTool(runningReadAgents).execute("status", {});

    expect(result.details.statuses).toEqual([
      expect.objectContaining({
        name: "writer",
        role: "write",
        phase: "stalled",
        progress: undefined,
        activeTool: undefined,
      }),
    ]);
  });

  it("marks hung and stale-heartbeat agents as stalled", async () => {
    const stalled = member("stalled");
    const legacyStale = member("legacy-stale", { joinedAt: 0 });
    mockRoster(stalled, legacyStale);
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (_teamName, agentName) => agentName === "legacy-stale"
      ? {
          teamName: "team",
          agentName,
          lifecycleRunId: `${agentName}-run`,
          ready: true,
          currentAction: "working",
          lastHeartbeatAt: Date.now() - 120_000,
        }
      : null);
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([]);
    const runningReadAgents = new Map<string, RunningReadAgent>([
      ["team:stalled", runningAgent(stalled, { lastActivityAt: Date.now() - 20 * 60_000 })],
    ]);
    const tool = makeTool(runningReadAgents);

    const result = await tool.execute("status", {});

    expect(result.details.statuses.map(({ name, phase }: any) => [name, phase])).toEqual([
      ["stalled", "stalled"],
      ["legacy-stale", "stalled"],
    ]);
  });

  it("limits nested parents to children from their exact run", async () => {
    const own = member("own-active", { parentAgentName: "writer", parentLifecycleRunId: "writer-run" });
    const other = member("other-active", { parentAgentName: "other", parentLifecycleRunId: "other-run" });
    mockRoster(own, other);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue(null);
    vi.spyOn(reportEvents, "listTeamReportEvents").mockResolvedValue([
      report("own-finished", {
        requestedBy: "writer",
        createdAt: 2_000,
        metadata: { parentLifecycleRunId: "writer-run" },
      }),
      report("own-finished", {
        id: "own-finished-wrong-run",
        requestedBy: "writer",
        createdAt: 3_000,
        summary: "Wrong run",
        metadata: { parentLifecycleRunId: "old-run" },
      }),
      report("old-own-finished", { requestedBy: "writer", createdAt: 900 }),
      report("other-finished", { requestedBy: "other", createdAt: 2_000 }),
    ]);
    const runningReadAgents = new Map<string, RunningReadAgent>([
      ["team:own-active", runningAgent(own, { status: "thinking" })],
      ["team:other-active", runningAgent(other)],
    ]);
    const queued: QueuedAgentStatus[] = [
      { name: "own-queued", role: "read", queuedAt: 2_000, queuePosition: 1, parentAgentName: "writer", parentLifecycleRunId: "writer-run" },
      { name: "other-queued", role: "read", queuedAt: 2_000, queuePosition: 2, parentAgentName: "other", parentLifecycleRunId: "other-run" },
    ];
    const tool = makeTool(runningReadAgents, queued, {
      parentName: "writer", parentRunId: "writer-run", parentStartedAt: 1_000,
    });

    const result = await tool.execute("status", {});
    const names = result.details.statuses.map((status: any) => status.name);

    expect(names).toEqual(["own-active", "own-queued", "own-finished"]);
    expect(result.details.statuses.find((status: any) => status.name === "own-finished")?.summary).toBe("Done");
    await expect(tool.execute("status", { agent_name: "other-active" }))
      .rejects.toThrow("no current status in this scope");
  });
});
