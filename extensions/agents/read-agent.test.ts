import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import { readInbox, sendPlainMessage } from "../../src/utils/messaging.js";
import { listTeamReportEvents } from "../../src/utils/report-events.js";

const piMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: [] as any[],
  sessionManagerInMemory: vi.fn((cwd: string) => ({ cwd })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession: piMocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      piMocks.loaderOptions.push(options);
    }

    async reload() {}
  },
  getAgentDir: () => "/mock-agent-dir",
  SessionManager: {
    inMemory: piMocks.sessionManagerInMemory,
  },
}));

import { runReadAgentInProcess } from "./read-agent.js";
import type { RunningReadAgent } from "../runtime/types.js";

let root: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function writeFavoriteLevels() {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "reading-default": { model: "provider/model", thinking: "high" },
    },
  }));
}

function makeSession() {
  return {
    messages: [{ role: "assistant", content: "final report" }],
    getSessionStats: vi.fn(() => ({ tokens: { total: 42 } })),
    subscribe: vi.fn(),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

describe("in-process read agent tool wiring", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-read-agent-"));
    piMocks.loaderOptions.length = 0;
    piMocks.createAgentSession.mockReset();
    piMocks.sessionManagerInMemory.mockClear();
    vi.spyOn(os, "homedir").mockReturnValue(root);
    installPathSpies();
    writeFavoriteLevels();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("injects teammate-safe communication tools and guidance into nested read-agent sessions", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(piMocks.createAgentSession).toHaveBeenCalledTimes(1);
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    const communicationToolNames = ["send_message", "read_inbox"];
    expect(sessionOptions.tools).toEqual(expect.arrayContaining(communicationToolNames));
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());

    expect(piMocks.loaderOptions).toHaveLength(1);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("Use send_message for direct communication and read_inbox only when you were told a reply is waiting");
    expect(promptText).toContain("If another agent is needed, report that need to the lead");

    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "reader", expect.any(Number), 42, "final report", true);
    expect(await readInbox("team", "team-lead", true, false)).toEqual([]);
    expect(await readInbox("team", "team-lead", false, false)).toEqual([]);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader");
    expect(runningReadAgents.size).toBe(0);
  });

  it("does not reset tool-working status for non-assistant message updates", async () => {
    let subscriber: ((event: any) => void) | undefined;
    const session = makeSession();
    session.subscribe.mockImplementation((callback: (event: any) => void) => {
      subscriber = callback;
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    session.prompt.mockImplementation(async () => {
      subscriber?.({ type: "tool_execution_start", toolName: "bash" });
      subscriber?.({ type: "message_update", message: { role: "toolResult", content: "not assistant text" } });
      expect(runningReadAgents.get("team:reader")).toMatchObject({ status: "working", activeToolName: "bash" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);
  });

  it("emits prompt-build reports even when prompt-build is not the adopted lead team", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "active-user-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("prompt-build-123", {
      agentId: "prompt-branch-1@prompt-build-123",
      name: "prompt-branch-1",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "build prompt options",
    }, "build prompt options", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).toHaveBeenCalledWith("prompt-build-123", "prompt-branch-1", expect.any(Number), 42, "final report", true);
    const leadInbox = await readInbox("prompt-build-123", "team-lead", false, false);
    expect(leadInbox).toEqual([]);
  });

  it("suppresses lead report injection for workflow-spawned read agents while persisting report events", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "workflow-reader@team",
      name: "workflow-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "workflow branch",
      metadata: { operationId: "op-1", workflowRunId: "run-1" },
    }, "workflow branch", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toEqual([]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "workflow-reader",
      status: "completed",
      report: "final report",
      operationId: "op-1",
      workflowRunId: "run-1",
      source: "read-agent",
    });
  });

  it("suppresses failed workflow read-agent injection while persisting failure events", async () => {
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("branch failed"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "workflow-reader@team",
      name: "workflow-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "workflow branch",
      metadata: { orchestration: { operationId: "op-1", workflowRunId: "run-1" } },
    }, "workflow branch", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toEqual([]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "workflow-reader",
      status: "failed",
      report: "Read agent workflow-reader failed: branch failed",
      operationId: "op-1",
      workflowRunId: "run-1",
      source: "read-agent",
    });
  });

  it("lead-run read helpers require the helper to send the full report and only a done notice to lead", async () => {
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      await sendPlainMessage("team", "writer-reader", "writer", "final report", "Read helper writer-reader report", "cyan");
      await sendPlainMessage("team", "writer-reader", "team-lead", "Read helper writer-reader completed for writer. Report sent to writer.", "Read helper writer-reader done", "cyan");
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
    };

    await runReadAgentInProcess("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    const requesterInbox = await readInbox("team", "writer", false, false);
    expect(requesterInbox).toHaveLength(1);
    expect(requesterInbox[0]).toMatchObject({
      from: "writer-reader",
      text: "final report",
      summary: "Read helper writer-reader report",
      color: "cyan",
      read: false,
    });

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({
      from: "writer-reader",
      summary: "Read helper writer-reader done",
      color: "cyan",
      read: false,
    });
    expect(leadInbox[0].text).toContain("Report sent to writer");
    expect(leadInbox[0].text).not.toBe("final report");
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    expect(options.quietTrigger).not.toHaveBeenCalled();
    expect(options.renderLeadInboxStatus).toHaveBeenCalled();

    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("You are a read helper requested by 'writer'");
    expect(promptText).toContain("send your concise report to the lead and stop");
  });

  it("uses a fallback delivery if a read helper exits without sending its required report", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
    };

    await runReadAgentInProcess("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    const requesterInbox = await readInbox("team", "writer", false, false);
    expect(requesterInbox).toHaveLength(1);
    expect(requesterInbox[0]).toMatchObject({
      from: "writer-reader",
      text: "final report",
      summary: "Read helper writer-reader report",
      color: "cyan",
      read: false,
    });

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].text).toContain("Report sent to writer");
  });
});
