import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHILD_AGENT_LIFECYCLE_PROBE, registerTeamTools } from "./team-tools.js";
import { createLifecycleRuntime } from "../team/lifecycle.js";
import { NESTED_SESSION_TEARDOWN_TIMEOUT_MS } from "../agents/read-agent-session-lifecycle.js";
import * as paths from "../../src/utils/paths.js";
import * as teams from "../../src/utils/teams.js";
import * as writeQueue from "../../src/utils/write-queue.js";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "../runtime/types.js";
import { ACCEPTED_FAVORITE_MODEL_SLOTS, FAVORITE_MODEL_SLOTS } from "../../src/utils/settings.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";
import { NESTED_READ_MODEL_SLOTS } from "../runtime/nested-read-agents.js";
import { closePersistedRecipient } from "../team/recipient-closure.js";

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: any;
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
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`));
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

function writeFavoriteLevels() {
  writeGlobalSettings({
    favoriteModels: {
      "read-collect": { model: "provider/model", thinking: "high" },
      "read-review": { model: "provider/model", thinking: "xhigh" },
      "read-analyze": { model: "provider/model", thinking: "medium" },
      "read-critical": { model: "provider/model", thinking: "xhigh" },
      "write-patch": { model: "provider/model", thinking: "max" },
      "write-feature": { model: "provider/model", thinking: "medium" },
      "write-system": { model: "provider/model", thinking: "high" },
      "write-critical": { model: "provider/model", thinking: "max" },
    },
  });
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
    runId: member.lifecycleRunId || `${member.name}-run`,
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
  const eventHandlers = new Map<string, Array<(payload: any) => void>>();
  const sessionHandlers = new Map<string, Array<(event: any) => void | Promise<void>>>();
  const eventUnsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
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
  const piEventEmit = vi.fn();
  const shutdownTeammate = vi.fn(async (teamName: string, member: Member) => {
    runningReadAgents.delete(readAgentKey(teamName, member.name));
    await teams.removeMember(teamName, member.name).catch(() => {});
    return {
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
    };
  });

  const sessionCtx = makeCtx();
  const teamToolsRuntime = registerTeamTools({
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: vi.fn((name: string, handler: (event: any) => void | Promise<void>) => {
      sessionHandlers.set(name, [...(sessionHandlers.get(name) ?? []), handler]);
    }),
    events: {
      on: vi.fn((name: string, handler: (payload: any) => void) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        const unsubscribe = vi.fn(() => {
          eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
        });
        eventUnsubscribes.set(name, unsubscribe);
        return unsubscribe;
      }),
      emit: piEventEmit,
    },
  }, {
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
    getSessionCtx: () => sessionCtx,
  });

  const emit = (name: string, payload: any) => {
    for (const handler of eventHandlers.get(name) ?? []) handler(payload);
  };
  const emitAsync = async (name: string, payload: any) => {
    await Promise.all((eventHandlers.get(name) ?? []).map((handler) => handler(payload)));
  };
  const shutdown = async (reason = "reload") => {
    for (const handler of sessionHandlers.get("session_shutdown") ?? []) await handler({ reason });
  };
  return { tools, teamToolsRuntime, runningReadAgents, completions, runReadAgentInProcess, adoptTeamAsLead, shutdownTeammate, emit, emitAsync, piEventEmit, shutdown, eventUnsubscribes };
}

async function admitNestedReadParent(
  harness: ReturnType<typeof registerTools>,
  overrides: Partial<Member> = {}
): Promise<Member> {
  const teamName = "session-test-session";
  if (!teams.teamExists(teamName)) {
    teams.createTeam(teamName, "test-session", "lead-agent", "Pi session agents", "provider/model");
  }
  const parent: Member = {
    agentId: `writer@${teamName}`,
    name: "writer",
    agentType: "teammate",
    role: "write",
    model: "provider/model",
    thinking: "medium",
    modelSlot: "write-feature",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: root,
    subscriptions: [],
    delegationDepth: 0,
    allowNestedReadAgents: true,
    ...overrides,
  };
  await teams.addMember(teamName, parent);
  harness.runningReadAgents.set(`${teamName}:${parent.name}`, makeRunningAgent(teamName, parent));
  return parent;
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

  it("publishes all canonical intent tiers, compatibility aliases, and agent-friendly defaults", () => {
    const { tools } = registerTools();
    const spawn = tools.get("spawn_agent")!;
    const swarm = tools.get("spawn_swarm_agents")!;
    const spawnSlot = spawn.parameters.properties.model_slot;
    const swarmDefaultSlot = swarm.parameters.properties.defaults.properties.model_slot;
    const swarmAgentSlot = swarm.parameters.properties.agents.items.properties.model_slot;
    const spawnNestedOptIn = spawn.parameters.properties.allow_nested_read_agents;
    const swarmDefaultNestedOptIn = swarm.parameters.properties.defaults.properties.allow_nested_read_agents;
    const swarmAgentNestedOptIn = swarm.parameters.properties.agents.items.properties.allow_nested_read_agents;

    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("read-"))).toHaveLength(4);
    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("write-"))).toHaveLength(4);
    expect(spawnSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
    expect(spawnSlot.default).toBe("read-review");
    expect(swarmDefaultSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
    expect(swarmAgentSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
    expect(spawnNestedOptIn.default).toBe(false);
    expect(swarmDefaultNestedOptIn.default).toBe(false);
    expect(swarmAgentNestedOptIn.default).toBe(false);
    expect(spawnNestedOptIn.description).toContain("write-feature/write-critical");
    expect(spawnSlot.description).toContain("read-review is the normal default");
    expect(spawnSlot.description).toContain("write-system owns a cross-cutting integration");
    expect(spawn.description).toContain("read-analyze for connected explanation/root cause");
    expect(spawn.description).toContain("wait literally idle");
    expect(spawn.description).toContain("never sleep, poll");
    expect(swarm.description).toContain("delegation-locked");
    expect(swarm.description).toContain("automatic reports");
  });

  it("spawn_agent creates an implicit current-session group and starts an in-process read agent by level", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess, adoptTeamAsLead } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_agent")!.execute("spawn", {
      name: "reader",
      prompt: "inspect one",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ name: "reader", role: "read", mode: "in-process", terminalId: null, session: "session-test-session", modelSlot: "read-review" });
    expect(adoptTeamAsLead).toHaveBeenCalledWith("session-test-session", ctx);
    expect(runReadAgentInProcess).toHaveBeenCalledWith(
      "session-test-session",
      expect.objectContaining({ name: "reader", role: "read", model: "provider/model", thinking: "xhigh", modelSlot: "read-review" }),
      "inspect one",
      ctx,
      expect.any(Object),
    );
  });

  it("canonicalizes persisted legacy model slots when reusing an existing member", async () => {
    const { runReadAgentInProcess, emitAsync, piEventEmit } = registerTools();
    const ctx = makeCtx();
    teams.createTeam("session-test-session", "test-session", "lead-agent", "Pi session agents", "provider/model");
    await teams.addMember("session-test-session", {
      agentId: "writer@session-test-session",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "high",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "%1",
      cwd: root,
      subscriptions: [],
      isActive: true,
    });

    await emitAsync("pi-extended-teams:orchestration-request", {
      requestId: "reuse-writer",
      type: "spawn_teammate_once",
      params: {
        team_name: "session-test-session",
        name: "writer",
        prompt: "continue existing work",
        cwd: root,
        model_slot: "writing-hard",
      },
      ctx,
    });

    expect(piEventEmit).toHaveBeenCalledWith("pi-extended-teams:orchestration-response", expect.objectContaining({
      requestId: "reuse-writer",
      ok: true,
      details: expect.objectContaining({
        existing: true,
        idempotent: true,
        requestedModelSlot: "write-system",
        modelSlot: "write-system",
        role: "write",
      }),
    }));
    expect(runReadAgentInProcess).not.toHaveBeenCalled();
    expect((await teams.readConfig("session-test-session")).members.find((member) => member.name === "writer")?.modelSlot).toBe("writing-hard");
  });

  it("canonicalizes legacy requested slots when reusing a queued write", async () => {
    writeFavoriteLevels();
    const { runReadAgentInProcess, emitAsync, piEventEmit } = registerTools();
    const ctx = makeCtx();
    teams.createTeam("session-test-session", "test-session", "lead-agent", "Pi session agents", "provider/model");
    await writeQueue.enqueueWriteSpawn("session-test-session", {
      name: "writer",
      prompt: "continue queued work",
      cwd: root,
      modelSlot: "writing-hard",
    });

    await emitAsync("pi-extended-teams:orchestration-request", {
      requestId: "reuse-queued-writer",
      type: "spawn_teammate_once",
      params: {
        team_name: "session-test-session",
        name: "writer",
        prompt: "continue queued work",
        cwd: root,
        model_slot: "writing-hard",
      },
      ctx,
    });

    expect(piEventEmit).toHaveBeenCalledWith("pi-extended-teams:orchestration-response", expect.objectContaining({
      requestId: "reuse-queued-writer",
      ok: true,
      details: expect.objectContaining({
        queued: true,
        existing: true,
        idempotent: true,
        requestedModelSlot: "write-system",
        modelSlot: "write-system",
        modelSource: "queued",
        role: "write",
      }),
    }));
    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("rejects a public same-name spawn during quarantine and succeeds after old settlement", async () => {
    vi.useFakeTimers();
    try {
      writeFavoriteLevels();
      const { tools, runningReadAgents, runReadAgentInProcess, shutdownTeammate } = registerTools();
      const ctx = makeCtx();
      const abort = new AbortController().signal;
      const params = {
        name: "reader",
        prompt: "inspect one",
        cwd: root,
        model_slot: "read-review",
      };

      await tools.get("spawn_agent")!.execute("spawn-1", params, abort, undefined, ctx);
      const oldState = runningReadAgents.get("session-test-session:reader")!;
      let settleDelivery!: () => void;
      oldState.messageDeliveryTail = new Promise<void>((resolve) => { settleDelivery = resolve; });
      oldState.session = {
        hasExtensionHandlers: vi.fn(() => false),
        clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      } as any;
      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents,
        readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
        renderReadAgentStatus: vi.fn(),
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "session-test-session",
      });
      shutdownTeammate.mockImplementation(lifecycle.shutdownTeammate as any);
      // Simulate an inactive-update implementation that reports success without
      // writing. Matching removal closes admission, but the run fence must stay.
      vi.spyOn(teams, "updateMember").mockResolvedValueOnce();

      const retry = tools.get("spawn_agent")!.execute("spawn-2", params, abort, undefined, ctx);
      const retryRejection = expect(retry).rejects.toThrow("Retry after lifecycle cleanup settles");
      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
      await retryRejection;
      expect(oldState.teardownState).toBe("quarantined");
      expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
      expect(runningReadAgents.get("session-test-session:reader")).toBe(oldState);
      expect((await teams.readConfig("session-test-session")).members.some(member => member.name === "reader")).toBe(false);
      await expect(readLifecycleTombstone("session-test-session", "reader")).resolves.toMatchObject({
        status: "occupied",
        tombstone: { runId: oldState.runId },
      });

      await expect(tools.get("spawn_agent")!.execute("spawn-fenced", params, abort, undefined, ctx))
        .rejects.toThrow("lifecycle-quarantined");
      expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
      expect(runningReadAgents.get("session-test-session:reader")).toBe(oldState);

      settleDelivery();
      await oldState.teardownFinalizationPromise;
      expect(runningReadAgents.has("session-test-session:reader")).toBe(false);
      expect((await teams.readConfig("session-test-session")).members.some(member => member.name === "reader")).toBe(false);
      await expect(readLifecycleTombstone("session-test-session", "reader")).resolves.toEqual({ status: "absent" });

      await expect(tools.get("spawn_agent")!.execute("spawn-3", params, abort, undefined, ctx)).resolves.toMatchObject({
        details: { name: "reader", role: "read" },
      });
      expect(runReadAgentInProcess).toHaveBeenCalledTimes(2);
      expect(runningReadAgents.get("session-test-session:reader")?.runId).not.toBe(oldState.runId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts legacy public/settings aliases and normalizes spawned members", async () => {
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
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ modelSource: "favorite-slot", modelSlot: "read-collect" });
    expect(runReadAgentInProcess).toHaveBeenCalledWith(
      "session-test-session",
      expect.objectContaining({ name: "fast-reader", model: "provider/model", thinking: "low", modelSlot: "read-collect" }),
      "inspect quickly",
      ctx,
      expect.any(Object),
    );
  });

  it("requires a configured model_slot level", async () => {
    const { tools } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_agent")!.execute("spawn", {
      name: "missing-level",
      prompt: "inspect quickly",
      cwd: root,
    }, abort, undefined, ctx)).rejects.toThrow(/requires a configured model_slot intent tier/);

    await expect(tools.get("spawn_agent")!.execute("spawn", {
      name: "unset-level",
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx)).rejects.toThrow(/Favorite model slot "read-collect" is not configured/);
  });

  it("rejects direct model, thinking, or role selection", async () => {
    writeFavoriteLevels();
    const { tools } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_agent")!.execute("spawn", {
      name: "conflict-reader",
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
      thinking: "high",
    }, abort, undefined, ctx)).rejects.toThrow(/must use model_slot only.*thinking/);

    await expect(tools.get("spawn_agent")!.execute("spawn", {
      name: "role-reader",
      role: "read",
      prompt: "inspect quickly",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx)).rejects.toThrow(/must use model_slot only.*role/);
  });

  it("queues read agents at the configured cap behind spawn_agent", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const { tools, completions, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const first = await tools.get("spawn_agent")!.execute("spawn-1", {
      name: "reader-1",
      prompt: "inspect one",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);
    const second = await tools.get("spawn_agent")!.execute("spawn-2", {
      name: "reader-2",
      prompt: "inspect two",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);

    expect(first.details).toMatchObject({ queued: false, role: "read", mode: "in-process" });
    expect(second.details).toMatchObject({ queued: true, role: "read", queuePosition: 1 });
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);

    completions.get("reader-1")!();
    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(2));
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "reader-2", role: "read" });
  });

  it("drains one queued read only after the completed run's finalization releases capacity", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const { tools, runningReadAgents, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    let resolveRun!: () => void;
    let resolveFinalization!: () => void;

    runReadAgentInProcess.mockImplementationOnce((teamName: string, member: Member) => {
      const key = `${teamName}:${member.name}`;
      const state = {
        ...makeRunningAgent(teamName, member),
        teardownFinalizationPromise: new Promise<void>((resolve) => { resolveFinalization = resolve; }),
      } as any;
      runningReadAgents.set(key, state);
      return new Promise<void>((resolve) => { resolveRun = resolve; });
    });

    await tools.get("spawn_agent")!.execute("spawn-1", {
      name: "reader-1",
      prompt: "inspect one",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    await tools.get("spawn_agent")!.execute("spawn-2", {
      name: "reader-2",
      prompt: "inspect two",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);

    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
    resolveRun();
    await Promise.resolve();
    await Promise.resolve();
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);

    runningReadAgents.delete("session-test-session:reader-1");
    await teams.removeMember("session-test-session", "reader-1");
    resolveFinalization();

    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(2));
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "reader-2", role: "read" });
  });

  it("reserves queued read capacity before an async runner registers its running state", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const { tools, runningReadAgents, runReadAgentInProcess, emit } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    let resolveARun!: () => void;
    let resolveAFinalization!: () => void;
    let allowBRegistration!: () => void;
    let resolveBRun!: () => void;
    let resolveBFinalization!: () => void;
    const aRun = new Promise<void>((resolve) => { resolveARun = resolve; });
    const aFinalization = new Promise<void>((resolve) => { resolveAFinalization = resolve; });
    const bRegistrationGate = new Promise<void>((resolve) => { allowBRegistration = resolve; });
    const bRun = new Promise<void>((resolve) => { resolveBRun = resolve; });
    const bFinalization = new Promise<void>((resolve) => { resolveBFinalization = resolve; });

    runReadAgentInProcess.mockImplementation((teamName: string, member: Member) => {
      const key = `${teamName}:${member.name}`;
      if (member.name === "reader-a") {
        runningReadAgents.set(key, {
          ...makeRunningAgent(teamName, member),
          teardownFinalizationPromise: aFinalization,
        } as any);
        return aRun;
      }
      if (member.name === "reader-b") {
        return (async () => {
          await bRegistrationGate;
          runningReadAgents.set(key, {
            ...makeRunningAgent(teamName, member),
            teardownFinalizationPromise: bFinalization,
          } as any);
          await bRun;
        })();
      }
      runningReadAgents.set(key, makeRunningAgent(teamName, member));
      return new Promise<void>(() => {});
    });

    for (const name of ["reader-a", "reader-b", "reader-c"]) {
      await tools.get("spawn_agent")!.execute(`spawn-${name}`, {
        name,
        prompt: `inspect ${name}`,
        cwd: root,
        model_slot: "read-review",
      }, abort, undefined, ctx);
    }

    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);
    resolveARun();
    await Promise.resolve();
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(1);

    runningReadAgents.delete("session-test-session:reader-a");
    await teams.removeMember("session-test-session", "reader-a");
    resolveAFinalization();

    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(2));
    expect(runReadAgentInProcess.mock.calls.map(call => call[1].name)).toEqual(["reader-a", "reader-b"]);
    expect(runningReadAgents.has("session-test-session:reader-b")).toBe(false);
    const respond = vi.fn();
    emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
    expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 0, queued: 1 });

    allowBRegistration();
    await vi.waitFor(() => expect(runningReadAgents.has("session-test-session:reader-b")).toBe(true));
    resolveBRun();
    await Promise.resolve();
    await Promise.resolve();
    expect(runReadAgentInProcess).toHaveBeenCalledTimes(2);

    runningReadAgents.delete("session-test-session:reader-b");
    await teams.removeMember("session-test-session", "reader-b");
    resolveBFinalization();

    await vi.waitFor(() => expect(runReadAgentInProcess).toHaveBeenCalledTimes(3));
    expect(runReadAgentInProcess.mock.calls[2][1]).toMatchObject({ name: "reader-c", role: "read" });
  });

  it("reports running and queued child agents only for the matching Pi session", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const { tools, emit } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await tools.get("spawn_agent")!.execute("spawn-1", {
      name: "reader-1",
      prompt: "inspect one",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);
    await tools.get("spawn_agent")!.execute("spawn-2", {
      name: "reader-2",
      prompt: "inspect two",
      cwd: root,
      model_slot: "reading-fast",
    }, abort, undefined, ctx);

    const matching: any[] = [];
    emit("pi-extended-teams:child-agent-lifecycle-probe", {
      sessionId: "test-session",
      respond: (snapshot: any) => matching.push(snapshot),
    });
    expect(matching).toEqual([{ sessionId: "test-session", running: 1, queued: 1 }]);

    const mismatched: any[] = [];
    emit("pi-extended-teams:child-agent-lifecycle-probe", {
      sessionId: "other-session",
      respond: (snapshot: any) => mismatched.push(snapshot),
    });
    expect(mismatched).toEqual([]);
  });

  it("unsubscribes the lifecycle probe listener idempotently during reload shutdown", async () => {
    const { emit, shutdown, eventUnsubscribes } = registerTools();
    const respond = vi.fn();
    const payload = { sessionId: "test-session", respond };

    emit("pi-extended-teams:child-agent-lifecycle-probe", payload);
    expect(respond).toHaveBeenCalledTimes(1);

    await shutdown();
    await shutdown();
    emit("pi-extended-teams:child-agent-lifecycle-probe", payload);

    expect(eventUnsubscribes.get("pi-extended-teams:child-agent-lifecycle-probe")).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("spawn_swarm_agents requires every agent to have a configured level", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { cwd: root },
      agents: [
        { name: "a", prompt: "inspect a" },
      ],
    }, abort, undefined, ctx)).rejects.toThrow(/requires a configured model_slot intent tier/);

    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("spawn_swarm_agents applies default and per-agent levels", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const result = await tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { cwd: root, model_slot: "read-review" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", model_slot: "read-critical" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.spawned).toHaveLength(2);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "xhigh", modelSlot: "read-review" });
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "b", thinking: "xhigh", modelSlot: "read-critical" });
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
      defaults: { cwd: root, model_slot: "reading-fast" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", model_slot: "reading-hard" },
      ],
    }, abort, undefined, ctx);

    expect(result.details.spawned).toHaveLength(2);
    expect(runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "a", thinking: "low", modelSlot: "read-collect" });
    expect(runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "b", thinking: "xhigh", modelSlot: "read-critical" });
  });

  it("spawn_swarm_agents rejects per-agent direct model/thinking even with a default level", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { cwd: root, model_slot: "reading-fast" },
      agents: [
        { name: "a", prompt: "inspect a" },
        { name: "b", prompt: "inspect b", model: "provider/model", thinking: "xhigh" },
      ],
    }, abort, undefined, ctx)).rejects.toThrow(/must use model_slot only.*model.*thinking/);

    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("spawn_swarm_agents rejects direct defaults even when an agent supplies a level", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await expect(tools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { cwd: root, model: "provider/model", thinking: "low" },
      agents: [
        { name: "a", prompt: "inspect a", model_slot: "reading-hard" },
      ],
    }, abort, undefined, ctx)).rejects.toThrow(/must use model_slot only.*model.*thinking/);

    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("spawn_swarm_agents gives unnamed agents unique names across swarms", async () => {
    writeFavoriteLevels();
    const { tools, shutdownTeammate } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    const first = await tools.get("spawn_swarm_agents")!.execute("swarm-1", {
      defaults: { cwd: root, model_slot: "read-review" },
      agents: [{ prompt: "inspect one" }, { prompt: "inspect two" }],
    }, abort, undefined, ctx);
    const second = await tools.get("spawn_swarm_agents")!.execute("swarm-2", {
      defaults: { cwd: root, model_slot: "read-review" },
      agents: [{ prompt: "inspect three" }, { prompt: "inspect four" }],
    }, abort, undefined, ctx);

    const names = [...first.details.spawned, ...second.details.spawned].map((item: any) => item.name);
    expect(new Set(names).size).toBe(4);
    expect(names.every((name: string) => name.startsWith("agent-"))).toBe(true);
    expect(shutdownTeammate).not.toHaveBeenCalled();
  });

  it("stamps public agents at depth zero and honors only the dedicated single/default/per-agent opt-in", async () => {
    writeFavoriteLevels();
    const { tools, runReadAgentInProcess } = registerTools();
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await tools.get("spawn_agent")!.execute("single-default", {
      name: "single-default",
      prompt: "implement without delegation",
      cwd: root,
      model_slot: "write-feature",
      metadata: { allowNestedReadAgents: true, delegationDepth: 99 },
    }, abort, undefined, ctx);
    await tools.get("spawn_agent")!.execute("single-opt-in", {
      name: "single-opt-in",
      prompt: "implement with read helpers",
      cwd: root,
      model_slot: "write-critical",
      allow_nested_read_agents: true,
    }, abort, undefined, ctx);
    await tools.get("spawn_swarm_agents")!.execute("swarm-opt-in", {
      defaults: {
        cwd: root,
        model_slot: "write-feature",
        allow_nested_read_agents: true,
      },
      agents: [
        { name: "swarm-inherited", prompt: "inherit delegation" },
        { name: "swarm-disabled", prompt: "disable delegation", allow_nested_read_agents: false },
      ],
    }, abort, undefined, ctx);

    const spawnedMembers = runReadAgentInProcess.mock.calls.map((call) => call[1]);
    expect(spawnedMembers).toHaveLength(4);
    expect(spawnedMembers[0]).toMatchObject({
      name: "single-default",
      delegationDepth: 0,
      allowNestedReadAgents: false,
      metadata: { allowNestedReadAgents: true, delegationDepth: 99 },
    });
    expect(spawnedMembers[1]).toMatchObject({
      name: "single-opt-in",
      delegationDepth: 0,
      allowNestedReadAgents: true,
    });
    expect(spawnedMembers[2]).toMatchObject({
      name: "swarm-inherited",
      delegationDepth: 0,
      allowNestedReadAgents: true,
    });
    expect(spawnedMembers[3]).toMatchObject({
      name: "swarm-disabled",
      delegationDepth: 0,
      allowNestedReadAgents: false,
    });
  });

  it("creates restricted child tools only for a live canonical opted-in parent and rejects non-read or extra fields", async () => {
    writeFavoriteLevels();
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const outerCtx = makeCtx();
    const binding = {
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx,
    };
    const nestedTools = new Map(harness.teamToolsRuntime.createNestedReadAgentTools(binding).map((tool: any) => [tool.name, tool]));

    expect(Array.from(nestedTools.keys()).sort()).toEqual(["spawn_agent", "spawn_swarm_agents"]);
    expect(nestedTools.get("spawn_agent")!.parameters.properties.model_slot.enum).toEqual(NESTED_READ_MODEL_SLOTS);
    expect(nestedTools.get("spawn_swarm_agents")!.parameters.properties.defaults.properties.model_slot.enum).toEqual(NESTED_READ_MODEL_SLOTS);
    expect(nestedTools.get("spawn_swarm_agents")!.parameters.properties.agents.items.properties.model_slot.enum).toEqual(NESTED_READ_MODEL_SLOTS);

    for (const ineligibleParent of [
      { ...parent, allowNestedReadAgents: false, metadata: { allowNestedReadAgents: true, allow_nested_read_agents: true } },
      { ...parent, delegationDepth: 1 },
      { ...parent, modelSlot: "write-patch" },
      { ...parent, modelSlot: "write-system" },
      { ...parent, role: "read" as const, modelSlot: "read-critical" },
    ]) {
      expect(harness.teamToolsRuntime.createNestedReadAgentTools({ ...binding, parent: ineligibleParent })).toEqual([]);
    }

    await expect(nestedTools.get("spawn_agent")!.execute("write-tier", {
      name: "writer-child",
      prompt: "do not admit",
      model_slot: "write-feature",
    })).rejects.toThrow("requires a canonical read-* model_slot");
    await expect(nestedTools.get("spawn_agent")!.execute("legacy-read-tier", {
      name: "legacy-child",
      prompt: "do not admit",
      model_slot: "reading-fast",
    })).rejects.toThrow("requires a canonical read-* model_slot");
    await expect(nestedTools.get("spawn_agent")!.execute("cwd-override", {
      name: "escaped-child",
      prompt: "do not admit",
      model_slot: "read-review",
      cwd: path.join(root, "elsewhere"),
    })).rejects.toThrow("accepts only name, prompt, model_slot");
    await expect(nestedTools.get("spawn_swarm_agents")!.execute("invalid-swarm", {
      defaults: { model_slot: "read-review" },
      agents: [
        { name: "valid", prompt: "would be valid" },
        { name: "invalid", prompt: "must reject whole request", model_slot: "write-critical" },
      ],
    })).rejects.toThrow("requires a canonical read-* model_slot");
    expect(harness.runReadAgentInProcess).not.toHaveBeenCalled();

    harness.runningReadAgents.get("session-test-session:writer")!.runId = "replacement-run";
    await expect(nestedTools.get("spawn_agent")!.execute("stale-parent", {
      name: "stale-child",
      prompt: "do not admit",
      model_slot: "read-collect",
    })).rejects.toThrow("bound parent lifecycle is not active");
  });

  it("admits single and swarm children with forced parent provenance and never replaces a duplicate", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 8, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const outerCtx = makeCtx();
    const nestedTools = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx,
    }).map((tool: any) => [tool.name, tool]));

    const single = await nestedTools.get("spawn_agent")!.execute("single", {
      name: "child-one",
      prompt: "inspect one",
      model_slot: "read-critical",
    });
    expect(single.details).toMatchObject({ name: "child-one", role: "read", queued: false, modelSlot: "read-critical" });
    expect(harness.runReadAgentInProcess).toHaveBeenLastCalledWith(
      "session-test-session",
      expect.objectContaining({
        name: "child-one",
        role: "read",
        cwd: root,
        modelSlot: "read-critical",
        delegationDepth: 1,
        allowNestedReadAgents: false,
        parentAgentName: "writer",
        parentLifecycleRunId: parent.lifecycleRunId,
        requestedBy: "writer",
        helperKind: "read_helper",
      }),
      "inspect one",
      outerCtx,
      expect.any(Object),
    );

    await expect(nestedTools.get("spawn_agent")!.execute("duplicate", {
      name: "child-one",
      prompt: "replace one",
      model_slot: "read-review",
    })).rejects.toThrow("nested delegation cannot replace an existing run");
    expect(harness.shutdownTeammate).not.toHaveBeenCalled();

    const swarm = await nestedTools.get("spawn_swarm_agents")!.execute("swarm", {
      defaults: { model_slot: "read-collect" },
      agents: [
        { name: "child-two", prompt: "inspect two" },
        { name: "child-three", prompt: "inspect three", model_slot: "read-analyze" },
        { name: "child-four", prompt: "inspect four", model_slot: "read-review" },
      ],
    });
    expect(swarm.details.failed).toEqual([]);
    expect(swarm.details.spawned).toHaveLength(3);
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(4);

    const childCalls = harness.runReadAgentInProcess.mock.calls.map((call) => call[1]);
    expect(childCalls.map((child) => child.name)).toEqual(["child-one", "child-two", "child-three", "child-four"]);
    expect(childCalls.map((child) => child.modelSlot)).toEqual(["read-critical", "read-collect", "read-analyze", "read-review"]);
    expect(childCalls.every((child) => child.delegationDepth === 1
      && child.parentAgentName === "writer"
      && child.parentLifecycleRunId === parent.lifecycleRunId
      && child.cwd === root)).toBe(true);
  });

  it("denies nested spawning immediately when the live parent recipient closes", async () => {
    writeFavoriteLevels();
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const nestedTools = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: makeCtx(),
    }).map((tool: any) => [tool.name, tool]));
    const parentState = harness.runningReadAgents.get("session-test-session:writer")!;
    const spawn = nestedTools.get("spawn_agent")!;

    parentState.messageDeliveryClosed = true;
    await expect(spawn.execute("closed-delivery", {
      name: "closed-delivery-child",
      prompt: "must not start after delivery closes",
      model_slot: "read-review",
    })).rejects.toThrow("bound parent lifecycle is not active");
    parentState.messageDeliveryClosed = false;

    parentState.persistedRecipientClosed = true;
    await expect(spawn.execute("closed-recipient", {
      name: "closed-recipient-child",
      prompt: "must not start after recipient closes",
      model_slot: "read-review",
    })).rejects.toThrow("bound parent lifecycle is not active");

    expect(harness.runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("denies and removes a queued nested child when recipient closure precedes capacity drain", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold read capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedTools = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool]));
    const queued = await nestedTools.get("spawn_agent")!.execute("queued-child", {
      name: "queued-child",
      prompt: "wait for admission",
      model_slot: "read-collect",
    });
    expect(queued.details).toMatchObject({ name: "queued-child", queued: true, role: "read" });

    harness.runningReadAgents.get("session-test-session:writer")!.persistedRecipientClosed = true;
    harness.completions.get("capacity-blocker")!();

    await vi.waitFor(() => {
      const respond = vi.fn();
      harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
      expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 1, queued: 0 });
    });
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("session-test-session")).members.some((member) => member.name === "queued-child")).toBe(false);
  });

  it("rechecks parent authorization at queued lead admission and hard-stops delegation", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;

    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold read capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedTools = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool]));
    const queued = await nestedTools.get("spawn_agent")!.execute("queued-child", {
      name: "queued-child",
      prompt: "wait for admission",
      model_slot: "read-collect",
    });
    expect(queued.details).toMatchObject({ name: "queued-child", queued: true, role: "read" });
    await expect(nestedTools.get("spawn_agent")!.execute("queued-duplicate", {
      name: "queued-child",
      prompt: "must not replace queued work",
      model_slot: "read-review",
    })).rejects.toThrow("nested delegation cannot replace an existing run");
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(1);

    const parentState = harness.runningReadAgents.get("session-test-session:writer")!;
    parentState.stopRequested = true;
    parentState.teardownState = "stopping";
    harness.completions.get("capacity-blocker")!();

    await vi.waitFor(() => {
      const respond = vi.fn();
      harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
      expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 1, queued: 0 });
    });
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("session-test-session")).members.some((member) => member.name === "queued-child")).toBe(false);
    await expect(nestedTools.get("spawn_agent")!.execute("after-stop", {
      name: "after-stop",
      prompt: "must not start",
      model_slot: "read-review",
    })).rejects.toThrow("bound parent lifecycle is not active");
  });

  it("rolls back only a deferred direct child admission when parent closure starts during add", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 8, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: makeCtx(),
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;
    const originalAddMember = teams.addMember;
    let markAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    vi.spyOn(teams, "addMember").mockImplementation(async (teamName, member) => {
      if (member.name === "racing-child") {
        markAddStarted();
        await addGate;
      }
      return originalAddMember(teamName, member);
    });

    const spawning = nestedSpawn.execute("racing-child", {
      name: "racing-child",
      prompt: "must lose to parent closure",
      model_slot: "read-review",
    });
    await addStarted;
    harness.runningReadAgents.get("session-test-session:writer")!.messageDeliveryClosed = true;
    const closing = closePersistedRecipient(
      "session-test-session",
      "writer",
      parent.lifecycleRunId!,
      { role: "write", removeOnFailure: true }
    );
    releaseAdd();

    await expect(spawning).rejects.toThrow("bound parent lifecycle is not active");
    await closing;
    expect(harness.runReadAgentInProcess).not.toHaveBeenCalled();
    expect((await teams.readConfig("session-test-session")).members.some((member) => member.name === "racing-child")).toBe(false);
  });

  it("rejects a queued request when parent closure wins during model precommit", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;
    let markModelLookupStarted!: () => void;
    const modelLookupStarted = new Promise<void>((resolve) => { markModelLookupStarted = resolve; });
    let releaseModels!: (models: any[]) => void;
    ctx.modelRegistry.getAvailable.mockImplementation(() => {
      markModelLookupStarted();
      return new Promise<any[]>((resolve) => { releaseModels = resolve; });
    });

    const spawning = nestedSpawn.execute("precommit-child", {
      name: "precommit-child",
      prompt: "must not enter the queue",
      model_slot: "read-collect",
    });
    await modelLookupStarted;
    harness.runningReadAgents.get("session-test-session:writer")!.messageDeliveryClosed = true;
    await closePersistedRecipient(
      "session-test-session",
      "writer",
      parent.lifecycleRunId!,
      { role: "write", removeOnFailure: true }
    );
    releaseModels([{ provider: "provider", id: "model" }]);

    await expect(spawning).rejects.toThrow("bound parent lifecycle is not active");
    const respond = vi.fn();
    harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
    expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 2, queued: 0 });
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(1);
  });

  it("rolls back a queued child when parent closure starts during drain admission", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;
    await nestedSpawn.execute("drain-child", {
      name: "drain-child",
      prompt: "wait for drain",
      model_slot: "read-collect",
    });

    const originalAddMember = teams.addMember;
    let markAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    vi.spyOn(teams, "addMember").mockImplementation(async (teamName, member) => {
      if (member.name === "drain-child") {
        markAddStarted();
        await addGate;
      }
      return originalAddMember(teamName, member);
    });

    harness.completions.get("capacity-blocker")!();
    await addStarted;
    harness.runningReadAgents.get("session-test-session:writer")!.messageDeliveryClosed = true;
    const closing = closePersistedRecipient(
      "session-test-session",
      "writer",
      parent.lifecycleRunId!,
      { role: "write", removeOnFailure: true }
    );
    releaseAdd();
    await closing;

    await vi.waitFor(() => {
      const respond = vi.fn();
      harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
      expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 1, queued: 0 });
    });
    expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("session-test-session")).members.some((member) => member.name === "drain-child")).toBe(false);
  });

  it("admits exactly one same-name request at capacity and launches it once", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;

    const settled = await Promise.allSettled([
      nestedSpawn.execute("same-name-a", { name: "same-name", prompt: "first", model_slot: "read-review" }),
      nestedSpawn.execute("same-name-b", { name: "same-name", prompt: "second", model_slot: "read-review" }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((settled.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value.details)
      .toMatchObject({ name: "same-name", queued: true });
    expect((settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message)
      .toContain("nested delegation cannot replace an existing run");

    harness.completions.get("capacity-blocker")!();
    await vi.waitFor(() => expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(2));
    expect(harness.runReadAgentInProcess.mock.calls.filter((call) => call[1].name === "same-name")).toHaveLength(1);
  });

  it("rejects a stale same-name queue request after a direct winner releases its reservation", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;

    const originalFindQueuedWriteSpawn = writeQueue.findQueuedWriteSpawn;
    let lookupCount = 0;
    let markWinnerLookupReached!: () => void;
    const winnerLookupReached = new Promise<void>((resolve) => { markWinnerLookupReached = resolve; });
    let markLoserLookupReached!: () => void;
    const loserLookupReached = new Promise<void>((resolve) => { markLoserLookupReached = resolve; });
    let releaseLoserLookup!: () => void;
    const loserLookupGate = new Promise<void>((resolve) => { releaseLoserLookup = resolve; });
    vi.spyOn(writeQueue, "findQueuedWriteSpawn").mockImplementation(async (...args) => {
      const result = await originalFindQueuedWriteSpawn(...args);
      lookupCount += 1;
      if (lookupCount === 1) {
        markWinnerLookupReached();
        await loserLookupReached;
      } else if (lookupCount === 2) {
        markLoserLookupReached();
        await loserLookupGate;
      }
      return result;
    });

    const winnerPromise = nestedSpawn.execute("same-name-direct", {
      name: "same-name-transfer",
      prompt: "start directly",
      model_slot: "read-review",
    });
    await winnerLookupReached;
    const loserPromise = nestedSpawn.execute("same-name-stale", {
      name: "same-name-transfer",
      prompt: "must not queue from a stale roster",
      model_slot: "read-review",
    });
    await loserLookupReached;

    const settled = await Promise.allSettled([
      winnerPromise.finally(releaseLoserLookup),
      loserPromise,
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((settled.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value.details)
      .toMatchObject({ name: "same-name-transfer", queued: false });
    expect((settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message)
      .toContain("nested delegation cannot replace an existing run");

    const activeRespond = vi.fn();
    harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond: activeRespond });
    expect(activeRespond).toHaveBeenCalledWith({ sessionId: "test-session", running: 2, queued: 0 });
    expect(harness.runReadAgentInProcess.mock.calls.filter((call) => call[1].name === "same-name-transfer")).toHaveLength(1);

    harness.completions.get("same-name-transfer")!();
    await vi.waitFor(() => {
      const completedRespond = vi.fn();
      harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond: completedRespond });
      expect(completedRespond).toHaveBeenCalledWith({ sessionId: "test-session", running: 1, queued: 0 });
    });
    expect(harness.runReadAgentInProcess.mock.calls.filter((call) => call[1].name === "same-name-transfer")).toHaveLength(1);
  });

  it("preserves a concurrent enqueue while the current queue head is draining", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;
    await nestedSpawn.execute("queued-one", { name: "queued-one", prompt: "first", model_slot: "read-review" });

    const originalAddMember = teams.addMember;
    let markAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    let releaseAdd!: () => void;
    const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    vi.spyOn(teams, "addMember").mockImplementation(async (teamName, member) => {
      if (member.name === "queued-one") {
        markAddStarted();
        await addGate;
      }
      return originalAddMember(teamName, member);
    });

    harness.completions.get("capacity-blocker")!();
    await addStarted;
    const queuedTwo = await harness.tools.get("spawn_agent")!.execute("queued-two", {
      name: "queued-two",
      prompt: "second",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    expect(queuedTwo.details).toMatchObject({ queued: true, queuePosition: 2 });
    releaseAdd();

    await vi.waitFor(() => expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(2));
    const respond = vi.fn();
    harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
    expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 2, queued: 1 });

    harness.completions.get("queued-one")!();
    await vi.waitFor(() => expect(harness.runReadAgentInProcess).toHaveBeenCalledTimes(3));
    expect(harness.runReadAgentInProcess.mock.calls[2][1].name).toBe("queued-two");
  });

  it("releases a queued nested-name reservation when the item is dropped", async () => {
    writeFavoriteLevels();
    writeProjectSettings({ readAgents: { maxConcurrent: 1, queueOverflow: true } });
    const harness = registerTools();
    const parent = await admitNestedReadParent(harness);
    const ctx = makeCtx();
    const abort = new AbortController().signal;
    await harness.tools.get("spawn_agent")!.execute("blocker", {
      name: "capacity-blocker",
      prompt: "hold capacity",
      cwd: root,
      model_slot: "read-review",
    }, abort, undefined, ctx);
    const nestedSpawn = new Map(harness.teamToolsRuntime.createNestedReadAgentTools({
      teamName: "session-test-session",
      parent,
      parentRunId: parent.lifecycleRunId!,
      outerCtx: ctx,
    }).map((tool: any) => [tool.name, tool])).get("spawn_agent")!;
    await nestedSpawn.execute("reserved-child", {
      name: "reserved-child",
      prompt: "queued request",
      model_slot: "read-review",
    });
    const duplicate: Member = {
      agentId: "reserved-child@session-test-session",
      name: "reserved-child",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "read-review",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    };
    await teams.addMember("session-test-session", duplicate);

    harness.completions.get("capacity-blocker")!();
    await vi.waitFor(() => {
      const respond = vi.fn();
      harness.emit(CHILD_AGENT_LIFECYCLE_PROBE, { sessionId: "test-session", respond });
      expect(respond).toHaveBeenCalledWith({ sessionId: "test-session", running: 1, queued: 0 });
    });
    await teams.removeMemberMatchingRun("session-test-session", duplicate.name, duplicate.lifecycleRunId!);

    await expect(nestedSpawn.execute("reserved-child-retry", {
      name: "reserved-child",
      prompt: "reservation must be reusable",
      model_slot: "read-review",
    })).resolves.toMatchObject({ details: { name: "reserved-child", queued: false } });
    expect(harness.runReadAgentInProcess.mock.calls.filter((call) => call[1].name === "reserved-child")).toHaveLength(1);
  });
});
