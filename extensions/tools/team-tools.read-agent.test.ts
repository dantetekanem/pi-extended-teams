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
}

function writeProjectSettings(settings: unknown) {
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "pi-extended-teams.json"), JSON.stringify(settings));
}

function makeCtx() {
  return {
    cwd: root,
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
  };
}

function makeRunningReadAgent(teamName: string, member: Member): RunningReadAgent {
  return {
    runId: `${member.name}-run`,
    name: member.name,
    teamName,
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
    runningReadAgents.set(key, makeRunningReadAgent(teamName, member));
    return new Promise<void>((resolve) => {
      completions.set(member.name, () => {
        runningReadAgents.delete(key);
        void teams.removeMember(teamName, member.name).catch(() => {}).finally(resolve);
      });
    });
  });

  registerTeamTools({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) }, {
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
    adoptTeamAsLead: vi.fn(),
    buildRoster: vi.fn(async () => ({})),
    isTeammate: false,
    agentName: "team-lead",
    getTeamName: () => "team",
  });

  return { tools, runningReadAgents, completions, runReadAgentInProcess };
}

async function createTeam() {
  teams.createTeam("team", "session", "lead", "", "provider/model");
}

describe("read-agent backpressure", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-read-backpressure-"));
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

  it("queues read teammates at the configured cap and drains FIFO when a reader finishes", async () => {
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    await createTeam();
    const { tools, completions, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const first = await tools.get("spawn_teammate")!.execute("spawn-1", {
      team_name: "team",
      name: "reader-1",
      role: "read",
      prompt: "inspect one",
      cwd: root,
    }, abort, undefined, ctx);
    const second = await tools.get("spawn_teammate")!.execute("spawn-2", {
      team_name: "team",
      name: "reader-2",
      role: "read",
      prompt: "inspect two",
      cwd: root,
    }, abort, undefined, ctx);

    expect(first.details).toMatchObject({ queued: false, role: "read", mode: "in-process" });
    expect(second.details).toMatchObject({ queued: true, role: "read", queuePosition: 1 });
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("team")).members.map(member => member.name)).toEqual(["team-lead", "reader-1"]);

    completions.get("reader-1")!();
    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(2));

    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "reader-2", role: "read" });
    expect((await teams.readConfig("team")).members.map(member => member.name)).toEqual(["team-lead", "reader-2"]);
  });

  it("rejects read teammates at capacity when read-agent queue overflow is disabled", async () => {
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: false } });
    await createTeam();
    const { tools } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await tools.get("spawn_teammate")!.execute("spawn-1", {
      team_name: "team",
      name: "reader-1",
      role: "read",
      prompt: "inspect one",
      cwd: root,
    }, abort, undefined, ctx);

    await expect(tools.get("spawn_teammate")!.execute("spawn-2", {
      team_name: "team",
      name: "reader-2",
      role: "read",
      prompt: "inspect two",
      cwd: root,
    }, abort, undefined, ctx)).rejects.toThrow("Read-agent capacity reached (1/1) and queueOverflow is disabled.");
  });

  it("keeps spawn_teammate_once idempotent for queued read teammates", async () => {
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    await createTeam();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await tools.get("spawn_teammate")!.execute("spawn-1", {
      team_name: "team",
      name: "reader-1",
      role: "read",
      prompt: "inspect one",
      cwd: root,
    }, abort, undefined, ctx);

    const queued = await tools.get("spawn_teammate_once")!.execute("spawn-once-1", {
      team_name: "team",
      name: "reader-2",
      role: "read",
      prompt: "inspect two",
      cwd: root,
      operation_id: "op-1",
      workflow_run_id: "run-1",
    }, abort, undefined, ctx);
    const repeated = await tools.get("spawn_teammate_once")!.execute("spawn-once-2", {
      team_name: "team",
      name: "reader-2-renamed",
      role: "read",
      prompt: "inspect two again",
      cwd: root,
      operation_id: "op-1",
      workflow_run_id: "run-1",
    }, abort, undefined, ctx);

    expect(queued.details).toMatchObject({ queued: true, queuePosition: 1 });
    expect(repeated.details).toMatchObject({ queued: true, queuePosition: 1, existing: true, idempotent: true });
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
  });
});
