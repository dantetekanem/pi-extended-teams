import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import { registerTaskRuntimeTools } from "./task-runtime-tools.js";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";

let root = "";

function registerTools(isTeammate: boolean) {
  const tools = new Map<string, any>();
  registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
    isTeammate,
    terminal: null,
    runningReadAgents: new Map(),
    readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    shutdownTeammate: vi.fn(async () => ({
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
  });
  return tools;
}

describe("task runtime tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "task-runtime-tools-"));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => {
      return path.join(root, String(teamName), "lifecycle", "quarantine", `${String(agentName)}.json`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps stop_teammate lead-only while leaving diagnostics available", () => {
    const leadTools = registerTools(false);
    const teammateTools = registerTools(true);

    expect(leadTools.has("stop_teammate")).toBe(true);
    expect(leadTools.has("check_teammate")).toBe(true);
    expect(teammateTools.has("stop_teammate")).toBe(false);
    expect(teammateTools.has("check_teammate")).toBe(true);
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
