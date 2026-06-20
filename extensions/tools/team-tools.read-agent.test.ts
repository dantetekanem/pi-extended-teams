import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTeamTools } from "./team-tools.js";
import * as paths from "../../src/utils/paths.js";
import * as teams from "../../src/utils/teams.js";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

let root: string;
let teamsRoot: string;
let tasksRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(tasksRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "writeQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "write-queue.json"));
  vi.spyOn(paths, "leadSessionPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lead-session.json"));
}

function writeProjectSettings(settings: unknown) {
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "pi-extended-teams.json"), JSON.stringify(settings));
}

function makeCtx() {
  return {
    cwd: root,
    sessionManager: { getSessionId: vi.fn(() => "test-session") },
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
  };
}

function makeRunningAgent(teamName: string, member: Member): RunningReadAgent {
  return {
    runId: `${member.name}-run`,
    name: member.name,
    teamName,
    role: member.role,
    startedAt: Date.now(),
    tokensUsed: 0,
    status: "thinking",
    recentEvents: [],
    lastActivityAt: Date.now(),
    model: member.model,
    thinking: member.thinking,
  };
}

function registerTools() {
  const tools = new Map<string, RegisteredTool>();
  const runningReadAgents = new Map<string, RunningReadAgent>();
  const completions = new Map<string, () => void>();
  const readAgentKey = (teamName: string, agentName: string) => `${teamName}:${agentName}`;
  const runReadAgentInProcess = vi.fn((teamName: string, member: Member) => {
    const key = readAgentKey(teamName, member.name);
    runningReadAgents.set(key, makeRunningAgent(teamName, member));
    return new Promise<void>((resolve) => {
      completions.set(member.name, () => {
        runningReadAgents.delete(key);
        void teams.removeMember(teamName, member.name).catch(() => {}).finally(resolve);
      });
    });
  });
  const adoptTeamAsLead = vi.fn();

  registerTeamTools({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool), events: { on: vi.fn(), emit: vi.fn() } }, {
    terminal: null,
    runningReadAgents,
    readAgentKey,
    isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
    renderReadAgentStatus: vi.fn(),
    readAgentOptions: vi.fn(() => ({})),
    runReadAgentInProcess,
    startWriteAgent: vi.fn(async () => "%1"),
    shutdownTeammate: vi.fn(async (teamName: string, member: Member) => {
      runningReadAgents.delete(readAgentKey(teamName, member.name));
      await teams.removeMember(teamName, member.name).catch(() => {});
    }),
    adoptTeamAsLead,
    buildRoster: vi.fn(async () => ({})),
    isTeammate: false,
    agentName: "team-lead",
    getTeamName: () => "session-test-session",
  });

  return { tools, runningReadAgents, completions, runReadAgentInProcess, adoptTeamAsLead };
}

describe("public agent spawn tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-public-agents-"));
    teamsRoot = path.join(root, "teams");
    tasksRoot = path.join(root, "tasks");
    fs.mkdirSync(teamsRoot, { recursive: true });
    fs.mkdirSync(tasksRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers only the public spawn tools from team-tools", () => {
    const { tools } = registerTools();

    expect(Array.from(tools.keys()).sort()).toEqual(["spawn_agent", "spawn_swarm_agents"]);
  });

  it("spawn_agent creates an implicit current-session group and starts an in-process read agent", async () => {
    const { tools, runReadAgentInProcess, adoptTeamAsLead } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_agent")!.execute("spawn", {
      name: "reader",
      role: "read",
      prompt: "inspect one",
      cwd: root,
      model: "provider/model",
      thinking: "high",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ name: "reader", role: "read", mode: "in-process", terminalId: null, session: "session-test-session" });
    expect(adoptTeamAsLead).toHaveBeenCalledWith("session-test-session", ctx);
    expect(runReadAgentInProcess).toHaveBeenCalledWith(
      "session-test-session",
      expect.objectContaining({ name: "reader", role: "read", model: "provider/model", thinking: "high" }),
      "inspect one",
      ctx,
      expect.any(Object),
    );
  });

  it("queues read agents at the configured cap behind spawn_agent", async () => {
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const { tools, completions, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const first = await tools.get("spawn_agent")!.execute("spawn-1", {
      name: "reader-1",
      role: "read",
      prompt: "inspect one",
      cwd: root,
    }, abort, undefined, ctx);
    const second = await tools.get("spawn_agent")!.execute("spawn-2", {
      name: "reader-2",
      role: "read",
      prompt: "inspect two",
      cwd: root,
    }, abort, undefined, ctx);

    expect(first.details).toMatchObject({ queued: false, role: "read", mode: "in-process" });
    expect(second.details).toMatchObject({ queued: true, role: "read", queuePosition: 1 });
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);

    completions.get("reader-1")!();
    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(2));
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "reader-2", role: "read" });
  });

  it("spawn_swarm_agents applies defaults and per-agent overrides", async () => {
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { role: "read", cwd: root, model: "provider/model", thinking: "high" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", thinking: "xhigh" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.spawned).toHaveLength(2);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "high" });
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "b", thinking: "xhigh" });
  });
});
