import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import * as claims from "../../src/utils/claims.js";
import * as teams from "../../src/utils/teams.js";
import { readInbox, requireRunningMessageRecipient, sendPlainMessage, sendPlainMessageIfRunning } from "../../src/utils/messaging.js";
import { listTeamReportEvents } from "../../src/utils/report-events.js";
import type { Member } from "../../src/utils/models.js";

const piMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: [] as any[],
  loaderExtensions: [] as any[],
  settingsManagers: [] as any[],
  sessionManagerInMemory: vi.fn((cwd: string) => ({ cwd })),
}));

function mockedPiRuntimeApi() {
  return {
  createAgentSession: piMocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      piMocks.loaderOptions.push(options);
    }

    async reload() {}

    getExtensions() {
      return { extensions: piMocks.loaderExtensions, errors: [], runtime: {} };
    }
  },
  getAgentDir: () => "/mock-agent-dir",
  SettingsManager: {
    create: vi.fn((_cwd: string, _agentDir: string, options?: any) => {
      const manager = {
        projectTrusted: options?.projectTrusted ?? false,
        setProjectTrusted(trusted: boolean) { this.projectTrusted = trusted; },
        isProjectTrusted() { return this.projectTrusted; },
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      };
      piMocks.settingsManagers.push(manager);
      return manager;
    }),
  },
  SessionManager: {
    inMemory: piMocks.sessionManagerInMemory,
  },
  };
}

vi.mock("@mariozechner/pi-coding-agent", mockedPiRuntimeApi);
vi.mock("../internal/pi-runtime-api", () => ({
  loadPiRuntimeApi: async () => mockedPiRuntimeApi(),
}));

import { closeReadAgentMessageDelivery, handleReadAgentSessionEvent, runReadAgentInProcess, sendMessageToRunningReadAgent } from "./read-agent.js";
import { createLifecycleRuntime } from "../team/lifecycle.js";
import { sanitizeTuiLine } from "../ui/renderers.js";
import { NESTED_SESSION_TEARDOWN_TIMEOUT_MS } from "./read-agent-session-lifecycle.js";
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
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "claims.json");
  });
  vi.spyOn(paths, "reportEventsPath").mockImplementation((teamName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "reports.json");
  });
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function writeFavoriteLevels() {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "reading-default": { model: "provider/model", thinking: "high" },
      "writing-basic": { model: "provider/model", thinking: "high" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
      "write-feature": { model: "provider/model", thinking: "medium" },
      "write-critical": { model: "provider/model", thinking: "xhigh" },
    },
  }));
}

function writeTeamConfig(teamName: string, teammate: Member, additionalMembers: Member[] = []) {
  const configFile = paths.configPath(teamName);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    name: teamName,
    description: "",
    createdAt: Date.now(),
    leadAgentId: "lead",
    leadSessionId: "lead-session",
    members: [
      {
        agentId: `team-lead@${teamName}`,
        name: "team-lead",
        agentType: "lead",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
      },
      ...additionalMembers,
      teammate,
    ],
  }, null, 2));
}

function fixtureMember(name: string, role: "read" | "write" = "read", modelSlot?: string): Member {
  return {
    agentId: `${name}@fixture`,
    name,
    agentType: "teammate",
    role,
    model: "provider/model",
    thinking: role === "write" && modelSlot !== "writing-basic" ? "xhigh" : "high",
    modelSlot: modelSlot ?? (role === "write" ? "writing-hard" : "reading-default"),
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: root,
    subscriptions: [],
  };
}

function makeSession() {
  return {
    messages: [{ role: "assistant", content: "final report" }],
    getSessionStats: vi.fn(() => ({ tokens: { total: 42 } })),
    subscribe: vi.fn(),
    prompt: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    sendUserMessage: vi.fn(async () => {}),
    isStreaming: true,
    hasExtensionHandlers: vi.fn(() => false),
    extensionRunner: { emit: vi.fn(async () => {}) },
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

describe("in-process read agent tool wiring", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-read-agent-"));
    piMocks.loaderOptions.length = 0;
    piMocks.loaderExtensions.length = 0;
    piMocks.settingsManagers.length = 0;
    piMocks.createAgentSession.mockReset();
    piMocks.sessionManagerInMemory.mockClear();
    vi.spyOn(os, "homedir").mockReturnValue(root);
    installPathSpies();
    writeFavoriteLevels();
    writeTeamConfig("team", fixtureMember("reader"), [
      fixtureMember("writer", "write"),
      fixtureMember("workflow-reader"),
      fixtureMember("writer-reader"),
    ]);
    writeTeamConfig("prompt-build-123", fixtureMember("prompt-branch-1"));
    writeTeamConfig("session-main", fixtureMember("planner", "write", "writing-basic"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("steers scope updates directly into an active in-process agent", async () => {
    const session = makeSession();
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: true,
    };

    await expect(sendMessageToRunningReadAgent(state, "Inspect the new bash screenshot too.")).resolves.toBe(true);

    expect(session.sendUserMessage).toHaveBeenCalledWith(
      "Inspect the new bash screenshot too.",
      { deliverAs: "steer" }
    );
    expect(state.status).toBe("thinking");
    expect(state.recentEvents).toContain("received lead message");
  });

  it("closes message admission without waiting for an in-flight session delivery", async () => {
    const session = makeSession();
    let finishDelivery!: () => void;
    session.sendUserMessage.mockImplementation(() => new Promise<void>((resolve) => { finishDelivery = resolve; }));
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: true,
      messageDeliveryClosed: false,
    };

    const delivery = sendMessageToRunningReadAgent(state, "Finish this evidence source.");
    const deliveryOutcome = delivery.then(() => "delivered", (error: Error) => error.message);
    await vi.waitFor(() => expect(session.sendUserMessage).toHaveBeenCalledOnce());
    const close = closeReadAgentMessageDelivery(state);

    expect(state.messageDeliveryClosed).toBe(true);
    expect(close.cancelledDeliveries).toBe(1);
    await expect(deliveryOutcome).resolves.toContain("was cancelled");
    await expect(sendMessageToRunningReadAgent(state, "New work.")).rejects.toThrow("agent is finishing");

    finishDelivery();
    await close.rawDeliverySettlement;
  });

  it("rejects scope updates once an in-process agent is finishing", async () => {
    const session = makeSession();
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "finishing",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: false,
    };

    await expect(sendMessageToRunningReadAgent(state, "Continue.")).rejects.toThrow(
      "Cannot send message to reader: agent is finishing."
    );
    expect(session.sendUserMessage).not.toHaveBeenCalled();
    await expect(sendMessageToRunningReadAgent(undefined, "Continue.")).resolves.toBe(false);
  });

  it("closes recipient delivery before asynchronous in-process cleanup", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    let finishClaimRelease!: () => void;
    const releaseAllClaimsForAgent = vi.fn(() => new Promise<string[]>((resolve) => {
      finishClaimRelease = () => resolve([]);
    }));
    const member: Member = {
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
    };
    writeTeamConfig("team", member);
    const run = runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    });

    await vi.waitFor(() => expect(releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader"));
    const duringCleanup = JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8"));
    expect(duringCleanup.members.find((item: Member) => item.name === "reader")?.isActive).toBe(false);
    expect(runningReadAgents.has("team:reader")).toBe(true);
    const rejectedRecipient = expect(requireRunningMessageRecipient("team", "reader"))
      .rejects.toThrow("agent is not running");

    finishClaimRelease();
    await run;
    await rejectedRecipient;
    expect(runningReadAgents.size).toBe(0);
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
    const communicationToolNames = ["send_message", "report_progress", "read_inbox", "report_and_exit"];
    expect(sessionOptions.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...communicationToolNames,
    ]);
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());

    expect(piMocks.loaderOptions).toHaveLength(1);
    expect(piMocks.loaderOptions[0]).toMatchObject({
      noExtensions: true,
      additionalExtensionPaths: [],
      noSkills: false,
    });
    expect(piMocks.loaderOptions[0].skillsOverride).toBeUndefined();
    expect(piMocks.loaderOptions[0].noPromptTemplates).toBeUndefined();
    expect(piMocks.loaderOptions[0].noThemes).toBeUndefined();
    expect(sessionOptions.settingsManager).toBe(piMocks.loaderOptions[0].settingsManager);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("Use send_message for direct communication and read_inbox only when you were told a reply is waiting");
    expect(promptText).toContain("If another agent is needed, use send_message to ask team-lead");
    expect(promptText).toContain("only the lead decides and performs the spawn");
    expect(promptText).toContain("Progress reporting is required, not optional UI polish");
    expect(promptText).toContain("Call report_progress before your first work tool");
    expect(promptText).toContain("never make more than 3 work-tool calls without a fresh progress update");
    expect(promptText).toContain("Use a new phrase describing what you are doing now");
    expect(promptText).toContain("without messaging or waking the lead");
    expect(promptText).toContain("use report_and_exit with the complete required deliverable");
    expect(promptText).toContain("Never replace required output with a summary");

    expect(session.bindExtensions).toHaveBeenCalledWith({ mode: "print" });
    expect(session.bindExtensions.mock.invocationCallOrder[0]).toBeLessThan(session.prompt.mock.invocationCallOrder[0]);
    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "reader", expect.any(Number), 42, "final report", true);
    expect(await readInbox("team", "team-lead", true, false)).toEqual([]);
    expect(await readInbox("team", "team-lead", false, false)).toEqual([]);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader");
    expect(runningReadAgents.size).toBe(0);
  });

  it("loads one immutable extension selection, activates its tools, and propagates parent trust", async () => {
    const session = makeSession();
    session.hasExtensionHandlers.mockReturnValue(true);
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["selected_extension_tool", { definition: { name: "selected_extension_tool" } }],
        ["send_message", { definition: { name: "send_message", description: "untrusted override" } }],
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const createResourcePlan = vi.fn(async (input: { cwd: string; projectTrusted: boolean }) => Object.freeze({
      selectionMode: "explicit" as const,
      extensionPaths: Object.freeze(["/extensions/selected.ts"]),
      extensions: Object.freeze([]),
      diagnostics: Object.freeze([]),
      skills: "all" as const,
      trust: Object.freeze({ cwd: input.cwd, projectTrusted: input.projectTrusted }),
    }));
    const runningReadAgents = new Map<string, RunningReadAgent>();

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
      cwd: root,
      isProjectTrusted: () => true,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
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
      createResourcePlan,
    });

    expect(createResourcePlan).toHaveBeenCalledOnce();
    expect(createResourcePlan).toHaveBeenCalledWith({ cwd: root, projectTrusted: true });
    expect(piMocks.loaderOptions[0]).toMatchObject({
      additionalExtensionPaths: ["/extensions/selected.ts"],
      noExtensions: true,
      noSkills: false,
    });
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toContain("selected_extension_tool");
    expect(sessionOptions.tools.filter((name: string) => name === "send_message")).toHaveLength(1);
    expect(sessionOptions.tools).not.toContain("spawn_agent");
    expect(sessionOptions.tools).not.toContain("spawn_swarm_agents");
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "send_message")?.description).not.toBe("untrusted override");
    expect(sessionOptions.customTools.some((tool: any) => tool.name === "spawn_agent" || tool.name === "spawn_swarm_agents")).toBe(false);
    expect(piMocks.settingsManagers.at(-1)?.isProjectTrusted()).toBe(true);
    expect(session.bindExtensions.mock.invocationCallOrder[0]).toBeLessThan(session.prompt.mock.invocationCallOrder[0]);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0]).toBeLessThan(session.clearQueue.mock.invocationCallOrder[0]);
    expect(session.clearQueue.mock.invocationCallOrder[0]).toBeLessThan(session.abort.mock.invocationCallOrder[0]);
    expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it("replaces filtered external spawn collisions with restricted tools only for an opted-in write-feature parent", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const restrictedTools = [
      { name: "spawn_agent", description: "restricted single", execute: vi.fn() },
      { name: "spawn_swarm_agents", description: "restricted swarm", execute: vi.fn() },
    ];
    const createNestedReadAgentTools = vi.fn(() => restrictedTools);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const member: Member = {
      agentId: "feature-writer@team",
      name: "feature-writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "medium",
      modelSlot: "write-feature",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "implement a bounded feature",
      delegationDepth: 0,
      allowNestedReadAgents: true,
    };
    writeTeamConfig("team", member);
    const outerCtx = {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    };

    await runReadAgentInProcess("team", member, "implement a bounded feature", outerCtx, {
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
      createNestedReadAgentTools,
    });

    expect(createNestedReadAgentTools).toHaveBeenCalledOnce();
    expect(createNestedReadAgentTools).toHaveBeenCalledWith({
      teamName: "team",
      parent: member,
      parentRunId: member.lifecycleRunId,
      outerCtx,
    });
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools.filter((name: string) => name === "spawn_agent")).toEqual(["spawn_agent"]);
    expect(sessionOptions.tools.filter((name: string) => name === "spawn_swarm_agents")).toEqual(["spawn_swarm_agents"]);
    expect(sessionOptions.customTools).toEqual(expect.arrayContaining(restrictedTools));
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "spawn_agent")?.description).toBe("restricted single");
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "spawn_swarm_agents")?.description).toBe("restricted swarm");
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("opted-in depth-0 write-feature/write-critical run");
    expect(promptText).toContain("restricted spawn_agent or spawn_swarm_agents");
    expect(promptText).toContain("any canonical read-* tier and any helper count");
    expect(promptText).toContain("global read capacity and queue");
    expect(promptText).toContain("Children report to you and cannot delegate");
  });

  it.each([
    { label: "non-opted-in write-feature", role: "write" as const, modelSlot: "write-feature", thinking: "medium" as const, delegationDepth: 0, allowNestedReadAgents: false },
    { label: "opted-in write-patch", role: "write" as const, modelSlot: "write-patch", thinking: "high" as const, delegationDepth: 0, allowNestedReadAgents: true },
    { label: "opted-in write-system", role: "write" as const, modelSlot: "write-system", thinking: "xhigh" as const, delegationDepth: 0, allowNestedReadAgents: true },
    { label: "depth-1 read child", role: "read" as const, modelSlot: "read-review", thinking: "high" as const, delegationDepth: 1, allowNestedReadAgents: true },
  ])("does not assign delegation tools to $label sessions", async ({ label, role, modelSlot, thinking, delegationDepth, allowNestedReadAgents }) => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const createNestedReadAgentTools = vi.fn(() => [
      { name: "spawn_agent", execute: vi.fn() },
      { name: "spawn_swarm_agents", execute: vi.fn() },
    ]);
    const member: Member = {
      agentId: `${label}@team`,
      name: label.replaceAll(" ", "-"),
      agentType: "teammate",
      role,
      model: "provider/model",
      thinking,
      modelSlot,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "bounded assignment",
      delegationDepth,
      allowNestedReadAgents,
      parentAgentName: delegationDepth === 1 ? "writer" : undefined,
      parentLifecycleRunId: delegationDepth === 1 ? "writer-run" : undefined,
      requestedBy: delegationDepth === 1 ? "writer" : undefined,
      helperKind: delegationDepth === 1 ? "read_helper" : undefined,
    };
    writeTeamConfig("team", member);

    await runReadAgentInProcess("team", member, "bounded assignment", {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents: new Map<string, RunningReadAgent>(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools,
    });

    expect(createNestedReadAgentTools).not.toHaveBeenCalled();
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).not.toContain("spawn_agent");
    expect(sessionOptions.tools).not.toContain("spawn_swarm_agents");
    expect(sessionOptions.customTools.some((tool: any) => tool.name === "spawn_agent" || tool.name === "spawn_swarm_agents")).toBe(false);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).not.toContain("opted-in depth-0 write-feature/write-critical run");
    if (delegationDepth === 1) {
      expect(promptText).toContain(`depth-1 read helper requested by 'writer'`);
      expect(promptText).toContain("report_and_exit deliverable goes to that requesting writer");
      expect(promptText).toContain("lead receives only a classified completion notice");
      expect(promptText).toContain("You cannot delegate");
      expect(promptText).not.toContain("send your concise report to the lead");
    }
  });

  it("injects the complete writer coordination surface into nested write-agent sessions", async () => {
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
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    }, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(piMocks.createAgentSession).toHaveBeenCalledTimes(1);
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    const communicationToolNames = [
      "send_message",
      "report_progress",
      "read_inbox",
      "claim_file",
      "release_file",
      "list_file_claims",
      "report_and_exit",
    ];
    expect(sessionOptions.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...communicationToolNames,
    ]);
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "writer", expect.any(Number), 42, "final report", true);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("accepts only the first writer report and finalizes only the nested run", async () => {
    const session = makeSession();
    session.messages = [{ role: "assistant", content: "trailing assistant text" }];
    let firstResult: any;
    let duplicateResult: any;
    let lateSendError: unknown;
    session.prompt.mockImplementation(async () => {
      expect(runningReadAgents.get("team:writer")).toMatchObject({ modelSlot: "write-system" });
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const tools = new Map<string, any>(sessionOptions.customTools.map((tool: any) => [tool.name, tool]));
      await tools.get("claim_file").execute("claim", { paths: ["./fixtures/writer.txt"] });
      firstResult = await tools.get("report_and_exit").execute("first", {
        content: "authoritative report",
        summary: "Authoritative summary",
      });
      lateSendError = await sendPlainMessageIfRunning("team", "other-agent", "writer", "late message", "Late")
        .then(() => undefined, error => error);
      duplicateResult = await tools.get("report_and_exit").execute("duplicate", {
        content: "duplicate report",
        summary: "Duplicate summary",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const releaseAllClaimsForAgent = vi.fn(async (teamName: string, agentName: string) => {
      return claims.releaseAllForAgent(teamName, agentName);
    });
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    };
    writeTeamConfig("team", writer);
    const leadShutdown = vi.fn();
    const terminalKill = vi.fn();

    await runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
      shutdown: leadShutdown,
      terminal: { kill: terminalKill },
    }, options);

    expect(firstResult.details).toEqual({
      session: "team",
      accepted: true,
      cancelledDeliveries: 0,
      deliveryOutcome: "none",
    });
    expect(lateSendError).toEqual(expect.objectContaining({ message: expect.stringContaining("lifecycle-quarantined") }));
    expect(await readInbox("team", "writer", false, false)).toEqual([]);
    expect(duplicateResult.details).toEqual({ session: "team", accepted: false });
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledTimes(1);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "completed",
      report: "authoritative report",
      summary: "Authoritative summary",
      modelSlot: "write-system",
    }));
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({ text: "authoritative report", summary: "Authoritative summary" });
    expect(leadInbox[0].metadata).toMatchObject({
      finalReport: true,
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "write-system",
      initialPrompt: "edit an isolated file",
    });
    expect(releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(await claims.listClaims("team")).toEqual([]);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(leadShutdown).not.toHaveBeenCalled();
    expect(terminalKill).not.toHaveBeenCalled();
    expect(runningReadAgents.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8")).members.map((item: Member) => item.name))
      .toEqual(["team-lead"]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "writer",
      role: "write",
      status: "completed",
      report: "authoritative report",
      summary: "Authoritative summary",
      source: "read-agent",
      modelSlot: "write-system",
      metadata: { initialPrompt: "edit an isolated file", modelSlot: "write-system" },
    });
    expect(JSON.stringify({ state: options.rememberCompletedAgentReport.mock.calls, leadInbox, reports })).not.toContain("writing-hard");
  });

  it("keeps stop-before-create quarantined until the late started session finishes shutdown", async () => {
    vi.useFakeTimers();
    try {
      let resolveCreation!: (value: { session: any }) => void;
      const creation = new Promise<{ session: any }>((resolve) => { resolveCreation = resolve; });
      let markCreationStarted!: () => void;
      const creationStarted = new Promise<void>((resolve) => { markCreationStarted = resolve; });
      piMocks.createAgentSession.mockImplementation(() => {
        markCreationStarted();
        return creation;
      });

      const order: string[] = [];
      const session = makeSession();
      session.hasExtensionHandlers.mockReturnValue(true);
      session.bindExtensions.mockImplementation(async () => { order.push("session_start"); });
      session.extensionRunner.emit.mockImplementation(async () => { order.push("session_shutdown"); });
      let resolveAbort!: () => void;
      const abort = new Promise<void>((resolve) => { resolveAbort = resolve; });
      session.abort.mockImplementation(() => abort);

      const reader: Member = {
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
      };
      writeTeamConfig("team", reader);
      const runningReadAgents = new Map<string, RunningReadAgent>();
      const releaseAllClaimsForAgent = vi.fn(async () => []);
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
        releaseAllClaimsForAgent,
      };
      const run = runReadAgentInProcess("team", reader, "investigate", {
        modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
      }, options);
      await creationStarted;
      const state = runningReadAgents.get("team:reader")!;
      expect(state.startupState).toBe("pending");

      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents,
        readAgentKey: options.readAgentKey,
        isCurrentReadAgentRun: options.isCurrentReadAgentRun,
        renderReadAgentStatus: options.renderReadAgentStatus,
        releaseAllClaimsForAgent,
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "team",
      });
      const stopping = lifecycle.shutdownTeammate("team", reader);
      await vi.waitFor(() => {
        const persisted = JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8"));
        expect(persisted.members.find((item: Member) => item.name === "reader")?.isActive).toBe(false);
      });
      expect(state.stopRequested).toBe(true);
      expect(state.acceptingMessages).toBe(false);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      resolveCreation({ session });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["session_start", "session_shutdown"]);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.dispose).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS - 1000);
      await expect(stopping).resolves.toMatchObject({
        status: "timed_out",
        abort: "timed_out",
        dispose: "deferred",
      });
      expect(state.teardownState).toBe("quarantined");
      expect(runningReadAgents.get("team:reader")).toBe(state);
      expect(session.dispose).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      resolveAbort();
      await state.teardownFinalizationPromise;
      await run;
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(releaseAllClaimsForAgent).toHaveBeenCalledOnce();
      expect(runningReadAgents.has("team:reader")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts report_and_exit without aborting or waiting for a stuck direct delivery", async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      let settleRawDelivery!: () => void;
      const rawDelivery = new Promise<void>((resolve) => { settleRawDelivery = resolve; });
      let markDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
      session.sendUserMessage.mockImplementation(() => {
        markDeliveryStarted();
        return rawDelivery;
      });
      let releasePrompt!: () => void;
      const promptRelease = new Promise<void>((resolve) => { releasePrompt = resolve; });
      let reportSubmitted!: () => void;
      const submitted = new Promise<void>((resolve) => { reportSubmitted = resolve; });
      let abortStarted!: () => void;
      const aborting = new Promise<void>((resolve) => { abortStarted = resolve; });
      session.abort.mockImplementation(async () => { abortStarted(); });

      const runningReadAgents = new Map<string, RunningReadAgent>();
      let reportResult: any;
      let deliveryOutcome: Promise<unknown> | undefined;
      session.prompt.mockImplementation(async () => {
        const state = runningReadAgents.get("team:writer")!;
        deliveryOutcome = sendMessageToRunningReadAgent(state, "Queued scope update")
          .catch((error: Error) => error);
        await deliveryStarted;
        const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
        const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
        reportResult = await reportTool.execute("report", {
          content: "authoritative report",
          summary: "Done",
        });
        reportSubmitted();
        await promptRelease;
      });
      piMocks.createAgentSession.mockResolvedValue({ session });
      const writer: Member = {
        agentId: "writer@team",
        name: "writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "xhigh",
        modelSlot: "writing-hard",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
        prompt: "edit an isolated file",
      };
      writeTeamConfig("team", writer);
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

      const run = runReadAgentInProcess("team", writer, "edit an isolated file", {
        modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
      }, options);
      await submitted;

      expect(reportResult.details).toMatchObject({
        accepted: true,
        cancelledDeliveries: 1,
        deliveryOutcome: "cancelled",
      });
      expect(session.abort).not.toHaveBeenCalled();
      await expect(deliveryOutcome).resolves.toEqual(expect.objectContaining({
        message: expect.stringContaining("was cancelled"),
      }));

      releasePrompt();
      await aborting;
      await vi.advanceTimersByTimeAsync(2500);
      await run;
      const quarantined = runningReadAgents.get("team:writer")!;
      expect(quarantined.teardownState).toBe("quarantined");
      expect(session.dispose).not.toHaveBeenCalled();

      settleRawDelivery();
      await quarantined.teardownFinalizationPromise;
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(runningReadAgents.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept or dispose a nested run when persisted report admission cannot close", async () => {
    const session = makeSession();
    let reportError: unknown;
    session.prompt.mockImplementation(async () => {
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      reportError = await reportTool.execute("report", {
        content: "must not be accepted",
        summary: "Rejected report",
      }).then(() => undefined, (error: unknown) => error);
    });
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
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
      isActive: true,
    };
    writeTeamConfig("team", writer);
    vi.spyOn(teams, "updateMember").mockRejectedValue(new Error("config lock unavailable"));
    vi.spyOn(teams, "removeMemberMatchingRun").mockRejectedValue(new Error("config removal unavailable"));

    await expect(runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options)).rejects.toThrow("Could not close message admission for writer in team");

    expect(reportError).toEqual(expect.objectContaining({
      message: expect.stringContaining("Could not close message admission for writer in team"),
    }));
    expect((await teams.readConfig("team")).members.find(member => member.name === "writer")?.isActive).toBe(true);
    expect(options.rememberCompletedAgentReport).not.toHaveBeenCalled();
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(runningReadAgents.has("team:writer")).toBe(true);
  });

  it("reports unexpected writer errors as failures even after report submission", async () => {
    const session = makeSession();
    session.hasExtensionHandlers.mockReturnValue(true);
    let reportResult: any;
    session.prompt.mockImplementation(async () => {
      expect(runningReadAgents.get("team:writer")).toMatchObject({ modelSlot: "write-system" });
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      reportResult = await reportTool.execute("report", {
        content: "submitted before failure",
        summary: "Submitted summary",
      });
      throw new Error("unexpected provider failure");
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const releaseAllClaimsForAgent = vi.fn(async (teamName: string, agentName: string) => {
      return claims.releaseAllForAgent(teamName, agentName);
    });
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    };
    writeTeamConfig("team", writer);
    const leadShutdown = vi.fn();
    const terminalKill = vi.fn();

    await runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
      shutdown: leadShutdown,
      terminal: { kill: terminalKill },
    }, options);

    expect(reportResult.details).toEqual({
      session: "team",
      accepted: true,
      cancelledDeliveries: 0,
      deliveryOutcome: "none",
    });
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledTimes(1);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "failed",
      report: "Edit agent writer failed: unexpected provider failure",
      modelSlot: "write-system",
    }));
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].metadata).toMatchObject({
      finalReport: true,
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "write-system",
      initialPrompt: "edit an isolated file",
    });
    expect(releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(leadShutdown).not.toHaveBeenCalled();
    expect(terminalKill).not.toHaveBeenCalled();
    expect(runningReadAgents.size).toBe(0);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "writer",
      role: "write",
      status: "failed",
      report: "Edit agent writer failed: unexpected provider failure",
      source: "read-agent",
      modelSlot: "write-system",
      metadata: { initialPrompt: "edit an isolated file", modelSlot: "write-system" },
    });
    expect(JSON.stringify({ state: options.rememberCompletedAgentReport.mock.calls, leadInbox, reports })).not.toContain("writing-hard");
  });

  it("preserves the full per-update assistant snippet while processing text deltas incrementally", () => {
    const state = {
      runId: "run-reader",
      name: "reader",
      teamName: "team",
      startedAt: 0,
      tokensUsed: 0,
      status: "thinking",
      recentEvents: [],
      lastActivityAt: 0,
    } as RunningReadAgent;
    const session = { getSessionStats: () => ({ tokens: { total: 42 } }) } as any;
    const renderReadAgentStatus = vi.fn();
    const expectedSnippet = (text: string) => {
      const sanitized = sanitizeTuiLine(text).trim();
      return sanitized.length > 180 ? `…${sanitized.slice(-179)}` : sanitized;
    };

    let firstPart = "";
    handleReadAgentSessionEvent(state, session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: firstPart }] },
    }, renderReadAgentStatus);

    for (const delta of ["Alpha\t", "beta\n", "gamma ", "x".repeat(2_500)]) {
      firstPart += delta;
      const message = { role: "assistant", content: [{ type: "text", text: firstPart }] };
      handleReadAgentSessionEvent(state, session, {
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
      }, renderReadAgentStatus);
      expect(state.latestAssistantSnippet).toBe(expectedSnippet(firstPart));
    }

    let secondPart = "";
    let message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: message },
    }, renderReadAgentStatus);
    secondPart = "second part";
    message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: secondPart, partial: message },
    }, renderReadAgentStatus);
    expect(state.latestAssistantSnippet).toBe(expectedSnippet(`${firstPart}\n${secondPart}`));

    secondPart += "\x1b[2K\runsafe tail";
    message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "\x1b[2K\runsafe tail", partial: message },
    }, renderReadAgentStatus);
    expect(state.latestAssistantSnippet).toBe(expectedSnippet(`${firstPart}\n${secondPart}`));
    expect(state.tokensUsed).toBe(42);
    expect(renderReadAgentStatus).toHaveBeenCalledTimes(7);
  });

  it("refreshes exact session stats on every update even when message history is unchanged", () => {
    const state = {
      runId: "run-reader",
      name: "reader",
      teamName: "team",
      startedAt: 0,
      tokensUsed: 0,
      status: "thinking",
      recentEvents: [],
      lastActivityAt: 0,
    } as RunningReadAgent;
    let tokensUsed = 42;
    const session = {
      messages: [{ role: "user", content: "prompt" }],
      getSessionStats: vi.fn(() => ({ tokens: { total: tokensUsed } })),
    } as any;
    const renderReadAgentStatus = vi.fn();
    const update = { type: "message_update", message: { role: "toolResult", content: "partial" } };

    handleReadAgentSessionEvent(state, session, update, renderReadAgentStatus);
    expect(state.tokensUsed).toBe(42);
    tokensUsed = 43;
    handleReadAgentSessionEvent(state, session, update, renderReadAgentStatus);

    expect(session.getSessionStats).toHaveBeenCalledTimes(2);
    expect(state.tokensUsed).toBe(43);
    expect(renderReadAgentStatus).toHaveBeenCalledTimes(2);
  });

  it("emits normalized progress without resetting tool-working status for non-assistant message updates", async () => {
    let subscriber: ((event: any) => void) | undefined;
    const session = makeSession();
    session.subscribe.mockImplementation((callback: (event: any) => void) => {
      subscriber = callback;
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    session.prompt.mockImplementation(async () => {
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const progressTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_progress");
      await progressTool.execute("progress", { status: "  Inspecting\n event   handling  " });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "thinking",
        latestProgress: "Inspecting event handling",
        progressUpdatedAt: expect.any(Number),
      });

      subscriber?.({ type: "tool_execution_start", toolName: "bash" });
      subscriber?.({ type: "message_update", message: { role: "toolResult", content: "not assistant text" } });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "working",
        activeToolName: "bash",
        latestProgress: "Inspecting event handling",
      });
      subscriber?.({ type: "tool_execution_end", toolName: "bash" });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "thinking",
        latestProgress: "Inspecting event handling",
      });
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
      emitAgentProgress: vi.fn(),
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

    expect(options.emitAgentProgress).toHaveBeenCalledWith("team", "reader", "Inspecting event handling", expect.any(Number));
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

  it("emits a private pi-prompt writer report without requesting lead injection", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "session-main",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(), renderReadAgentStatus: vi.fn(), rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(), releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("session-main", {
      agentId: "planner@session-main", name: "planner", agentType: "teammate", role: "write",
      model: "provider/model", thinking: "high", modelSlot: "writing-basic", joinedAt: Date.now(),
      tmuxPaneId: "", cwd: root, subscriptions: [], prompt: "write plan",
      metadata: { piPromptPlanning: { version: 1, correlation: "private" } },
    }, "write plan", { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } }, options);

    expect(options.emitAgentReport).toHaveBeenCalledWith("session-main", "planner", expect.any(Number), 42, "final report", true, true);
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

  it("directly wakes an active helper requester even when the helper already persisted its report", async () => {
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
      notifyLeadOfInboxReports: vi.fn(async () => {}),
      deliverMessageToActiveAgent: vi.fn(async () => true),
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

    expect(options.deliverMessageToActiveAgent).toHaveBeenCalledWith("team", "writer", "final report");

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(2);
    const classifiedNotice = leadInbox.find(message => message.metadata?.helperCompletion === true);
    expect(classifiedNotice).toMatchObject({
      from: "writer-reader",
      summary: "Read helper writer-reader done",
      color: "cyan",
      read: false,
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "completed",
        requestedBy: "writer",
      },
    });
    expect(classifiedNotice?.text).toContain("Report sent to writer");
    expect(classifiedNotice?.text).not.toBe("final report");
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    expect(options.quietTrigger).not.toHaveBeenCalled();
    expect(options.renderLeadInboxStatus).toHaveBeenCalled();
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");

    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("depth-1 read helper requested by 'writer'");
    expect(promptText).toContain("report_and_exit deliverable goes to that requesting writer");
    expect(promptText).toContain("lead receives only a classified completion notice");
    expect(promptText).not.toContain("send your concise report to the lead and stop");
  });

  it("uses a fallback delivery if a read helper exits without sending its required report", async () => {
    writeTeamConfig("team", {
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
    }, [{
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    }]);
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
      notifyLeadOfInboxReports: vi.fn(async () => {}),
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
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "completed",
        requestedBy: "writer",
      },
    });
    expect(leadInbox[0].text).toContain("Report sent to writer");
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");
  });

  it("keeps rapid same-name helper notices and tmux reports isolated by run id", async () => {
    const helper: Member = {
      agentId: "reused-helper@team",
      name: "reused-helper",
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
      isActive: true,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    };
    writeTeamConfig("team", helper, [writer]);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const notifyLeadOfInboxReports = vi.fn(async () => {});
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
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports,
      deliverMessageToActiveAgent: vi.fn(async () => false),
    };

    const firstSession = makeSession();
    piMocks.createAgentSession.mockResolvedValueOnce({ session: firstSession });
    await runReadAgentInProcess("team", helper, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    const firstNotices = await readInbox("team", "team-lead", false, false);
    expect(firstNotices).toHaveLength(1);
    const firstRunId = firstNotices[0].metadata?.runId;
    expect(firstRunId).toEqual(expect.any(String));
    await readInbox("team", "team-lead", true, true);

    await teams.addMember("team", { ...helper, joinedAt: Date.now(), isActive: true });
    const secondSession = makeSession();
    secondSession.prompt.mockRejectedValue(new Error("second run failed"));
    piMocks.createAgentSession.mockResolvedValueOnce({ session: secondSession });
    await runReadAgentInProcess("team", { ...helper, joinedAt: Date.now(), isActive: true }, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    const classifiedNotices = (await readInbox("team", "team-lead", false, false))
      .filter(message => message.metadata?.helperCompletion === true);
    expect(classifiedNotices).toHaveLength(2);
    expect(classifiedNotices.map(message => message.metadata?.outcome)).toEqual(["completed", "failed"]);
    expect(classifiedNotices[1].metadata?.runId).toEqual(expect.any(String));
    expect(classifiedNotices[1].metadata?.runId).not.toBe(firstRunId);
    const unreadLead = await readInbox("team", "team-lead", true, false);
    expect(unreadLead).toHaveLength(1);
    expect(unreadLead[0].metadata?.runId).toBe(classifiedNotices[1].metadata?.runId);
    expect(notifyLeadOfInboxReports).toHaveBeenCalledTimes(2);

    const requesterReports = await readInbox("team", "writer", false, false);
    expect(requesterReports).toHaveLength(2);
    expect(requesterReports.map(message => message.metadata?.outcome)).toEqual(["completed", "failed"]);
    expect(new Set(requesterReports.map(message => message.metadata?.runId)).size).toBe(2);
  });

  it("publishes a rejected prompt failure while the helper remains live during deferred delivery", async () => {
    const helper: Member = {
      agentId: "failing-helper@team",
      name: "failing-helper",
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
    };
    writeTeamConfig("team", helper, [{
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    }]);
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("source unavailable"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const liveFailureRenders: RunningReadAgent[] = [];
    let markFailureDeliveryStarted!: () => void;
    const failureDeliveryStarted = new Promise<void>((resolve) => { markFailureDeliveryStarted = resolve; });
    let releaseFailureDelivery!: () => void;
    const failureDeliveryGate = new Promise<void>((resolve) => { releaseFailureDelivery = resolve; });
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(() => {
        const state = runningReadAgents.get("team:failing-helper");
        if (state?.lastError) liveFailureRenders.push(state);
      }),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports: vi.fn(async () => {}),
      deliverMessageToActiveAgent: vi.fn(async () => {
        markFailureDeliveryStarted();
        await failureDeliveryGate;
        return true;
      }),
    };

    const run = runReadAgentInProcess("team", helper, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);
    await failureDeliveryStarted;

    const liveFailureState = runningReadAgents.get("team:failing-helper");
    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(liveFailureState?.lastError).toMatchObject({ message: "source unavailable" });
    expect(liveFailureState?.lastError?.timestamp).toEqual(expect.any(Number));
    expect(liveFailureRenders).toContain(liveFailureState);
    expect(runningReadAgents.get("team:failing-helper")).toBe(liveFailureState);

    releaseFailureDelivery();
    await run;
    expect(runningReadAgents.has("team:failing-helper")).toBe(false);
    expect(options.deliverMessageToActiveAgent).toHaveBeenCalledWith(
      "team",
      "writer",
      "Read agent failing-helper failed: source unavailable"
    );
    expect(await readInbox("team", "writer", false, false)).toEqual([]);
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "failed",
        requestedBy: "writer",
      },
    });
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledTimes(1);
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");
    expect(options.quietTrigger).not.toHaveBeenCalled();
  });
});
