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

function writeGlobalSettings(settings: unknown) {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
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
  const shutdownTeammate = vi.fn(async (teamName: string, member: Member) => {
    runningReadAgents.delete(readAgentKey(teamName, member.name));
    await teams.removeMember(teamName, member.name).catch(() => {});
  });

  registerTeamTools({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool), events: { on: vi.fn(), emit: vi.fn() } }, {
    terminal: null,
    runningReadAgents,
    readAgentKey,
    isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
    renderReadAgentStatus: vi.fn(),
    readAgentOptions: vi.fn(() => ({})),
    runReadAgentInProcess,
    startWriteAgent: vi.fn(async () => "%1"),
    shutdownTeammate,
    adoptTeamAsLead,
    buildRoster: vi.fn(async () => ({})),
    isTeammate: false,
    agentName: "team-lead",
    getTeamName: () => "session-test-session",
  });

  return { tools, runningReadAgents, completions, runReadAgentInProcess, adoptTeamAsLead, shutdownTeammate };
}

describe("public agent spawn tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-public-agents-"));
    teamsRoot = path.join(root, "teams");
    tasksRoot = path.join(root, "tasks");
    fs.mkdirSync(teamsRoot, { recursive: true });
    fs.mkdirSync(tasksRoot, { recursive: true });
    installPathSpies();
    vi.spyOn(os, "homedir").mockReturnValue(root);
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

  it("spawn_agent uses a configured favorite model slot", async () => {
    writeGlobalSettings({
      favoriteModels: {
        "reading-fast": { model: "provider/model", thinking: "low" },
      },
    });
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_agent")!.execute("spawn", {
      name: "fast-reader",
      role: "read",
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ modelSource: "favorite-slot", modelSlot: "reading-fast" });
    expect(runReadAgentInProcess).toHaveBeenCalledWith(
      "session-test-session",
      expect.objectContaining({ name: "fast-reader", model: "provider/model", thinking: "low", modelSlot: "reading-fast" }),
      "inspect quickly",
      ctx,
      expect.any(Object),
    );
  });

  it("rejects model_slot combined with explicit model or thinking", async () => {
    writeGlobalSettings({
      favoriteModels: {
        "reading-fast": { model: "provider/model", thinking: "low" },
      },
    });
    const { tools } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_agent")!.execute("spawn", {
      name: "conflict-reader",
      role: "read",
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
      thinking: "high",
    }, abort, undefined, ctx)).rejects.toThrow(/model_slot cannot be combined/);
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

  it("spawn_swarm_agents applies default and per-agent favorite model slots", async () => {
    writeGlobalSettings({
      favoriteModels: {
        "reading-fast": { model: "provider/model", thinking: "low" },
        "reading-hard": { model: "provider/model", thinking: "xhigh" },
      },
    });
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { role: "read", cwd: root, model_slot: "reading-fast" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", model_slot: "reading-hard" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.spawned).toHaveLength(2);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "low", modelSlot: "reading-fast" });
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "b", thinking: "xhigh", modelSlot: "reading-hard" });
  });

  it("spawn_swarm_agents lets per-agent explicit model/thinking override a default model_slot", async () => {
    writeGlobalSettings({
      favoriteModels: {
        "reading-fast": { model: "provider/model", thinking: "low" },
      },
    });
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { role: "read", cwd: root, model_slot: "reading-fast" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", model: "provider/model", thinking: "xhigh" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.failed).toEqual([]);
    expect(result.details.spawned).toHaveLength(2);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "low", modelSlot: "reading-fast" });
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "b", thinking: "xhigh" });
    expect(runReadAgentInProcess.mock.calls[1][1].modelSlot).toBeUndefined();
  });

  it("spawn_swarm_agents lets per-agent model_slot override default model/thinking", async () => {
    writeGlobalSettings({
      favoriteModels: {
        "reading-hard": { model: "provider/model", thinking: "xhigh" },
      },
    });
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { role: "read", cwd: root, model: "provider/model", thinking: "low" },
      agents: [
        { name: "a", prompt: "inspect a", model_slot: "reading-hard" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.failed).toEqual([]);
    expect(result.details.spawned).toHaveLength(1);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "xhigh", modelSlot: "reading-hard" });
  });

  it("spawn_swarm_agents gives unnamed agents unique names across swarms", async () => {
    const { tools, shutdownTeammate } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const first = await tools.get("spawn_swarm_agents")!.execute("swarm-1", {
      defaults: { role: "read", cwd: root, model: "provider/model", thinking: "high" },
      agents: [{ prompt: "inspect one" }, { prompt: "inspect two" }],
    }, abort, undefined, ctx);
    const second = await tools.get("spawn_swarm_agents")!.execute("swarm-2", {
      defaults: { role: "read", cwd: root, model: "provider/model", thinking: "high" },
      agents: [{ prompt: "inspect three" }, { prompt: "inspect four" }],
    }, abort, undefined, ctx);

    const names = [...first.details.spawned, ...second.details.spawned].map((item: any) => item.name);
    expect(new Set(names).size).toBe(4);
    expect(names.every((name: string) => name.startsWith("agent-"))).toBe(true);
    expect(shutdownTeammate).not.toHaveBeenCalled();
  });
});
