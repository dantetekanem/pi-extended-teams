import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import { readInbox, sendPlainMessage } from "../../src/utils/messaging.js";

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
    installPathSpies();
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
    const communicationToolNames = ["send_message", "broadcast_message", "read_inbox", "request_teammate"];
    expect(sessionOptions.tools).toEqual(expect.arrayContaining(communicationToolNames));
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());

    expect(piMocks.loaderOptions).toHaveLength(1);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("Use send_message, broadcast_message, and read_inbox");
    expect(promptText).toContain("call request_teammate to ask the team lead");

    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "reader", expect.any(Number), 42, "final report", true);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader");
    expect(runningReadAgents.size).toBe(0);
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
    expect(promptText).toContain("must call send_message to send your full report to 'writer'");
    expect(promptText).toContain("After both messages are sent");
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
