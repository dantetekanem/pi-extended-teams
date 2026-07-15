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
  registerTeamTools({
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
  return { tools, runningReadAgents, completions, runReadAgentInProcess, adoptTeamAsLead, shutdownTeammate, emit, emitAsync, piEventEmit, shutdown, eventUnsubscribes };
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

    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("read-"))).toHaveLength(4);
    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("write-"))).toHaveLength(4);
    expect(spawnSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
    expect(spawnSlot.default).toBe("read-review");
    expect(swarmDefaultSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
    expect(swarmAgentSlot.enum).toEqual(ACCEPTED_FAVORITE_MODEL_SLOTS);
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
});
