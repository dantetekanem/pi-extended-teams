import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Key } from "@mariozechner/pi-tui";
import { LEGACY_FAVORITE_MODEL_SLOT_ALIASES } from "../src/utils/settings";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

const testRoot = path.join(os.tmpdir(), "pi-extended-teams-extension-" + Date.now());

function makeCtx(cwd: string, sessionId = "test-session") {
  return {
    cwd,
    mode: "tui",
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(async (..._args: any[]): Promise<any> => undefined),
      getToolsExpanded: vi.fn(() => false),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn((..._args: any[]): any => undefined),
    },
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => true),
    shutdown: vi.fn(),
  };
}

async function setupExtension(
  env: Record<string, string | undefined> = {},
  options: { withSendMessage?: boolean } = {}
) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  delete process.env.PI_TEAM_NAME;
  delete process.env.PI_AGENT_NAME;
  process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT = "0";
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const terminal = {
    spawn: vi.fn(() => `%${terminal.spawn.mock.calls.length}`),
    kill: vi.fn(),
    isAlive: vi.fn(() => true),
    setTitle: vi.fn(),
    focusPane: vi.fn(() => true),
    getCurrentPaneId: vi.fn(() => process.env.TMUX_PANE || "%lead"),
    getWindowIdForPane: vi.fn((paneId: string) => paneId ? `@${paneId.replace("%", "")}` : null),
  };

  vi.doMock("../src/adapters/terminal-registry", () => ({ getTerminalAdapter: () => terminal }));

  const readAgentMock = {
    runReadAgentInProcess: vi.fn(),
    sendMessageToRunningReadAgent: vi.fn(async () => false),
    closeReadAgentMessageDelivery: vi.fn((state: any) => {
      state.acceptingMessages = false;
      state.messageDeliveryClosed = true;
      return state.messageDeliveryTail ?? Promise.resolve();
    }),
    shutdownReadAgentSession: vi.fn(async () => {}),
  };
  vi.doMock("./agents/read-agent.js", () => readAgentMock);

  const extensionModule = await import("./index.js") as any;
  const extension = extensionModule.default;
  const paths = await import("../src/utils/paths.js");
  const teams = await import("../src/utils/teams.js");

  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, "case-"));
  const teamsRoot = path.join(root, "teams");
  const tasksRoot = path.join(root, "tasks");
  fs.mkdirSync(teamsRoot, { recursive: true });
  fs.mkdirSync(tasksRoot, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(root);

  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(tasksRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "writeQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "write-queue.json"));
  vi.spyOn(paths, "readHelperQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "read-helper-queue.json"));
  vi.spyOn(paths, "leadSessionPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lead-session.json"));
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`));

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, Function[]>();
  const extensionEventHandlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerShortcut: vi.fn(),
    getCommands: vi.fn(() => Array.from(commands.keys()).map((name) => ({
      name,
      source: "extension",
      sourceInfo: {
        path: path.join(process.cwd(), "extensions", "index.ts"),
        source: "local",
        scope: "user",
        origin: "top-level",
      },
    }))),
    getAllTools: vi.fn(() => Array.from(tools.keys()).map((name) => ({
      name,
      sourceInfo: {
        path: path.join(process.cwd(), "extensions", "index.ts"),
        source: "local",
        scope: "user",
        origin: "top-level",
      },
    }))),
    on: vi.fn((name: string, handler: Function) => {
      eventHandlers.set(name, [...(eventHandlers.get(name) || []), handler]);
    }),
    events: {
      on: vi.fn((name: string, handler: Function) => {
        const target = name.startsWith("pi-") ? extensionEventHandlers : eventHandlers;
        target.set(name, [...(target.get(name) || []), handler]);
      }),
      emit: vi.fn(),
    },
    sendUserMessage: vi.fn(),
  };
  if (options.withSendMessage) pi.sendMessage = vi.fn();

  extension(pi as any);

  return {
    root,
    tools,
    commands,
    eventHandlers,
    extensionEventHandlers,
    pi,
    terminal,
    readAgentMock,
    teams,
    restoreEnv() {
      process.env = originalEnv;
      vi.restoreAllMocks();
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeFavoriteLevels(root: string) {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "read-collect": { model: "provider/model", thinking: "low" },
      "read-review": { model: "provider/model", thinking: "high" },
      "read-critical": { model: "provider/model", thinking: "xhigh" },
      "write-patch": { model: "provider/model", thinking: "high" },
      "write-critical": { model: "provider/model", thinking: "xhigh" },
    },
  }));
}

describe("extension integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the small public tool surface without legacy /agents or /team commands", async () => {
    const setup = await setupExtension();
    try {
      expect(Array.from(setup.tools.keys()).sort()).toEqual([
        "check_teammate",
        "claim_file",
        "list_file_claims",
        "read_inbox",
        "release_file",
        "report_and_exit",
        "send_message",
        "spawn_agent",
        "spawn_swarm_agents",
        "stop_teammate",
      ]);
      expect(setup.commands.has("agents")).toBe(false);
      expect(setup.commands.has("team")).toBe(false);
      expect(setup.commands.has("agents-favorite-models")).toBe(true);
      expect(setup.commands.has("agents-extensions")).toBe(true);
      expect(setup.pi.registerShortcut).toHaveBeenCalledWith(Key.alt("tab"), expect.objectContaining({ handler: expect.any(Function) }));
      expect(setup.tools.has("team_create")).toBe(false);
      expect(setup.tools.has("ensure_team")).toBe(false);
      expect(setup.tools.has("spawn_teammate")).toBe(false);
      expect(setup.tools.has("request_read_helper")).toBe(false);
      expect(setup.tools.has("list_available_models")).toBe(false);
    } finally {
      setup.restoreEnv();
    }
  });

  it("keeps public compatibility tables aligned with runtime aliases", () => {
    for (const documentPath of ["README.md", "TIPS.md", "docs/reference.md"]) {
      const document = fs.readFileSync(path.resolve(documentPath), "utf-8");
      for (const [legacy, canonical] of Object.entries(LEGACY_FAVORITE_MODEL_SLOT_ALIASES)) {
        expect(document).toContain(`| \`${legacy}\` | \`${canonical}\` |`);
      }
    }
  });

  it("does not expose report_progress in the lead session", async () => {
    const setup = await setupExtension();
    try {
      expect(setup.tools.has("report_progress")).toBe(false);
    } finally {
      setup.restoreEnv();
    }
  });

  it("report_progress updates runtime-backed agents without inbox or lead-turn side effects", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer", PI_LIFECYCLE_RUN_ID: "writer-run" });
    try {
      const paths = await import("../src/utils/paths.js");
      const config = setup.teams.createTeam("team", "writer-session", "lead", "", "provider/model");
      config.members.push({
        agentId: "writer@team",
        name: "writer",
        agentType: "teammate",
        role: "write",
        lifecycleRunId: "writer-run",
        joinedAt: Date.now(),
        tmuxPaneId: "%writer",
        cwd: setup.root,
        subscriptions: [],
      });
      fs.writeFileSync(paths.configPath("team"), JSON.stringify(config, null, 2));
      expect(setup.tools.has("spawn_agent")).toBe(false);
      expect(setup.tools.has("spawn_swarm_agents")).toBe(false);
      expect(setup.tools.has("send_message")).toBe(true);
      const runtime = await import("../src/utils/runtime.js");
      const messaging = await import("../src/utils/messaging.js");
      const ctx = makeCtx(setup.root, "writer-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);

      const result = await setup.tools.get("report_progress")!.execute("progress", {
        status: "  Running\n focused   tests  ",
      }, new AbortController().signal, undefined, ctx);

      expect(result.details).toMatchObject({ session: "team", status: "Running focused tests" });
      expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({
        currentAction: "starting",
        latestProgress: "Running focused tests",
        progressUpdatedAt: expect.any(Number),
      });
      expect(await messaging.readInbox("team", "team-lead", false, false)).toEqual([]);
      expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      setup.restoreEnv();
    }
  });

  it("warns lead sessions at boot when no favorite levels are configured", async () => {
    const setup = await setupExtension();
    try {
      const ctx = makeCtx(setup.root, "boot-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "No agent intent tiers are configured. Define them with /agents-favorite-models before spawning agents. See TIPS.md for intent-tier examples.",
        "warning"
      );
    } finally {
      setup.restoreEnv();
    }
  });

  it("spawn_agent creates the implicit current-session group and runs edit agents in-process by level", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      const ctx = makeCtx(setup.root, "edit-session");
      const abort = new AbortController().signal;

      const result = await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "editor",
        prompt: "Edit the file",
        cwd: setup.root,
        model_slot: "write-critical",
      }, abort, undefined, ctx);

      expect(result.details).toMatchObject({ name: "editor", role: "write", mode: "in-process", terminalId: null, session: "session-edit-session", modelSlot: "write-critical" });
      expect(setup.terminal.spawn).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledWith(
        "session-edit-session",
        expect.objectContaining({ name: "editor", role: "write", model: "provider/model", thinking: "xhigh", modelSlot: "write-critical" }),
        "Edit the file",
        ctx,
        expect.any(Object),
      );

      const config = await setup.teams.readConfig("session-edit-session");
      expect(config.members.map((member: any) => member.name)).toEqual(["team-lead", "editor"]);
    } finally {
      setup.restoreEnv();
    }
  });

  it("rejects direct delivery when the active same-name agent has a different lifecycle run", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      let capturedOptions: any;
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        capturedOptions = options;
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), {
          runId: "writer-run-B",
          name: member.name,
          teamName,
        });
      });
      const ctx = makeCtx(setup.root, "replacement-run-delivery-session");
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "writer",
        prompt: "Run the replacement assignment",
        cwd: setup.root,
        model_slot: "write-critical",
      }, new AbortController().signal, undefined, ctx);

      const delivered = await capturedOptions.deliverMessageToActiveAgent(
        "session-replacement-run-delivery-session",
        "writer",
        "stale child report",
        "writer-run-A"
      );

      expect(delivered).toBe(false);
      expect(setup.readAgentMock.sendMessageToRunningReadAgent).not.toHaveBeenCalled();
    } finally {
      setup.restoreEnv();
    }
  });

  it("captures public lead extension sourceInfo when the child resource plan is requested", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      const selfPath = path.join(process.cwd(), "extensions", "index.ts");
      const externalPath = path.join(setup.root, "extensions", "external.ts");
      setup.pi.getCommands.mockReturnValue([
        {
          name: "agents-extensions",
          source: "extension",
          sourceInfo: { path: selfPath, source: "local", scope: "user", origin: "top-level" },
        },
        {
          name: "external-command",
          source: "extension",
          sourceInfo: { path: externalPath, source: "local", scope: "user", origin: "top-level" },
        },
      ]);
      setup.pi.getAllTools.mockReturnValue([]);
      const ctx = makeCtx(setup.root, "extension-snapshot-session");

      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Inspect the project",
        cwd: setup.root,
        model_slot: "read-review",
      }, new AbortController().signal, undefined, ctx);

      const spawnOptions = setup.readAgentMock.runReadAgentInProcess.mock.calls[0]![4];
      const plan = spawnOptions.createResourcePlan({ cwd: setup.root, projectTrusted: true });
      expect(plan.selfExtensionPath).toBe(selfPath);
      expect(plan.extensionPaths).toEqual([externalPath]);
      expect(plan.extensions.map((extension: any) => extension.name)).toEqual(["pi-extended-teams", "external"]);
    } finally {
      setup.restoreEnv();
    }
  });

  it("emits only the minimal correlated nested-agent progress event", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      const ctx = makeCtx(setup.root, "progress-event-session");
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "planner-private",
        prompt: "Inspect the repository",
        cwd: setup.root,
        model_slot: "read-critical",
      }, new AbortController().signal, undefined, ctx);

      const options = setup.readAgentMock.runReadAgentInProcess.mock.calls[0]![4];
      options.emitAgentProgress("session-progress-event-session", "planner-private", "Reviewing focused tests", 1_720_000_000_000);

      expect(setup.pi.events.emit).toHaveBeenCalledWith("pi-extended-teams:agent-progress", {
        teamName: "session-progress-event-session",
        name: "planner-private",
        status: "Reviewing focused tests",
        updatedAt: 1_720_000_000_000,
      });
      const payload = vi.mocked(setup.pi.events.emit).mock.calls.at(-1)?.[1];
      for (const denied of ["model", "prompt", "cwd", "path", "tool", "result", "assistant", "tokens", "nonce", "skills", "thinking", "report"]) {
        expect(Object.keys(payload as object).join(" ").toLowerCase()).not.toContain(denied);
      }
    } finally {
      setup.restoreEnv();
    }
  });

  it("injects every new agent inbox message as a lead follow-up even while busy", async () => {
    const setup = await setupExtension({}, { withSendMessage: true });
    try {
      writeFavoriteLevels(setup.root);
      const ctx = makeCtx(setup.root);
      ctx.isIdle.mockReturnValue(false);
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);

      const abort = new AbortController().signal;
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Inspect this",
        cwd: setup.root,
        model_slot: "read-review",
      }, abort, undefined, ctx);

      const messaging = await import("../src/utils/messaging.js");
      const targetTeamName = "session-test-session";
      await messaging.sendPlainMessage(
        targetTeamName,
        "reader",
        "team-lead",
        "first report",
        "First report",
        undefined,
        { metadata: { finalReport: true } }
      );
      await vi.advanceTimersByTimeAsync(30_000);

      expect(setup.pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(setup.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "pi-extended-teams-wake", content: expect.stringContaining("A teammate finished and sent its final report"), display: false }),
        { triggerTurn: true, deliverAs: "followUp" }
      );
      const firstWake = setup.pi.sendMessage.mock.calls[0]?.[0]?.content;
      expect(firstWake).toContain("Call read_inbox once");
      expect(firstWake).toContain("continue the active task");
      expect(firstWake).toContain("reporting agent is self-exiting");
      expect(firstWake).toContain("do not call stop_teammate");
      expect(firstWake).not.toContain("shut down finished teammates");
      expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();

      await messaging.readInbox(targetTeamName, "team-lead", true, true);
      await messaging.sendPlainMessage(targetTeamName, "reader", "team-lead", "second report", "Second report");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(setup.pi.sendMessage).toHaveBeenCalledTimes(2);
      expect(setup.pi.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ customType: "pi-extended-teams-wake", content: expect.stringContaining("Check your agent messages now"), display: false }),
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } finally {
      setup.restoreEnv();
    }
  });

  it("delivers queued helper startup failures directly and retains them when the requester closes", async () => {
    const setup = await setupExtension({}, { withSendMessage: true });
    try {
      writeFavoriteLevels(setup.root);
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now(),
          tokensUsed: 0,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          acceptingMessages: true,
          messageDeliveryClosed: false,
          session: { isStreaming: true },
        });
      });
      setup.readAgentMock.sendMessageToRunningReadAgent.mockResolvedValue(true);
      const ctx = makeCtx(setup.root, "queued-helper-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "writer",
        prompt: "Own the parent task",
        cwd: setup.root,
        model_slot: "write-critical",
      }, new AbortController().signal, undefined, ctx);

      const queue = await import("../src/utils/read-helper-queue.js");
      const messaging = await import("../src/utils/messaging.js");
      const targetTeamName = "session-queued-helper-session";
      await queue.enqueueReadHelperRequest(targetTeamName, {
        requester: "writer",
        name: "helper-start-failure",
        prompt: "Inspect one source",
        cwd: setup.root,
        modelSlot: "missing-reading-slot" as any,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(setup.readAgentMock.sendMessageToRunningReadAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: "writer" }),
        expect.stringContaining("could not start for writer")
      );
      expect(await messaging.readInbox(targetTeamName, "writer", false, false)).toEqual([]);
      let leadInbox = await messaging.readInbox(targetTeamName, "team-lead", false, false);
      expect(leadInbox).toHaveLength(1);
      expect(leadInbox[0]).toMatchObject({
        metadata: { finalReport: true, helperCompletion: true, outcome: "failed", requestedBy: "writer" },
      });
      expect(leadInbox[0].text).toContain("Failure sent to writer");
      expect(setup.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("A teammate finished and sent its final report") }),
        { triggerTurn: true, deliverAs: "followUp" }
      );

      await messaging.readInbox(targetTeamName, "team-lead", true, true);
      await setup.teams.updateMember(targetTeamName, "writer", { isActive: false });
      setup.readAgentMock.sendMessageToRunningReadAgent.mockRejectedValueOnce(new Error("agent is finishing"));
      await queue.enqueueReadHelperRequest(targetTeamName, {
        requester: "writer",
        name: "helper-after-stop",
        prompt: "Inspect another source",
        cwd: setup.root,
        modelSlot: "missing-reading-slot" as any,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await messaging.readInbox(targetTeamName, "writer", false, false)).toEqual([]);
      leadInbox = await messaging.readInbox(targetTeamName, "team-lead", false, false);
      expect(leadInbox).toHaveLength(2);
      expect(leadInbox[1].text).toContain("writer is no longer running; the failure is retained here");
    } finally {
      setup.restoreEnv();
    }
  });

  it("observes queued-helper launch rejection without unhandled rejection or observer cleanup", async () => {
    const setup = await setupExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const ctx = makeCtx(setup.root, "helper-observer-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "writer",
        prompt: "own the task",
        cwd: setup.root,
        model_slot: "write-critical",
      }, new AbortController().signal, undefined, ctx);
      const helperDispose = vi.fn();
      let persistedHelperState: any;
      let helperRunningMap: Map<string, any>;
      setup.readAgentMock.runReadAgentInProcess.mockImplementationOnce((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        helperRunningMap = options.runningReadAgents;
        persistedHelperState = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now(),
          tokensUsed: 0,
          status: "finishing",
          recentEvents: [],
          lastActivityAt: Date.now(),
          teardownState: "persistence_failed",
          session: { dispose: helperDispose, getSessionStats: () => ({ tokens: { total: 0 } }) },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), persistedHelperState);
        return Promise.reject(new Error("terminal helper rejection"));
      });

      const queue = await import("../src/utils/read-helper-queue.js");
      await queue.enqueueReadHelperRequest("session-helper-observer-session", {
        requester: "writer",
        name: "helper",
        prompt: "inspect one source",
        cwd: setup.root,
        modelSlot: "reading-fast",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledTimes(2);
      const config = await setup.teams.readConfig("session-helper-observer-session");
      expect(config.members.map((member: any) => member.name)).toEqual(["team-lead", "writer", "helper"]);
      expect(persistedHelperState.teardownState).toBe("persistence_failed");
      expect(helperRunningMap!.get("session-helper-observer-session:helper")).toBe(persistedHelperState);
      expect(helperDispose).not.toHaveBeenCalled();
      expect(setup.terminal.kill).not.toHaveBeenCalled();
      const messaging = await import("../src/utils/messaging.js");
      expect(await messaging.readInbox("session-helper-observer-session", "team-lead", false, false)).toEqual([]);
    } finally {
      process.off("unhandledRejection", unhandled);
      setup.restoreEnv();
    }
  });

  it("observes prompt-build launch rejection without unhandled rejection or observer cleanup", async () => {
    const setup = await setupExtension();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const ctx = makeCtx(setup.root, "prompt-observer-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      const promptDispose = vi.fn();
      let persistedPromptState: any;
      let promptRunningMap: Map<string, any>;
      setup.readAgentMock.runReadAgentInProcess.mockImplementationOnce((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        promptRunningMap = options.runningReadAgents;
        persistedPromptState = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now(),
          tokensUsed: 0,
          status: "finishing",
          recentEvents: [],
          lastActivityAt: Date.now(),
          teardownState: "persistence_failed",
          session: { dispose: promptDispose, getSessionStats: () => ({ tokens: { total: 0 } }) },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), persistedPromptState);
        return Promise.reject(new Error("terminal prompt rejection"));
      });

      const handler = setup.extensionEventHandlers.get("pi-prompt:prompt-build:start")?.[0];
      expect(handler).toBeTypeOf("function");
      await handler!({
        teamName: "prompt-observer",
        prompts: ["build one branch"],
        cwd: setup.root,
        model_slot: "read-review",
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledOnce();
      const config = await setup.teams.readConfig("prompt-observer");
      expect(config.members.map((member: any) => member.name)).toEqual(["team-lead", "prompt-branch-1"]);
      expect(persistedPromptState.teardownState).toBe("persistence_failed");
      expect(promptRunningMap!.get("prompt-observer:prompt-branch-1")).toBe(persistedPromptState);
      expect(promptDispose).not.toHaveBeenCalled();
      expect(setup.terminal.kill).not.toHaveBeenCalled();
      expect(setup.pi.events.emit.mock.calls.some(([name]: [string]) => name === "pi-prompt:prompt-build:error")).toBe(false);
    } finally {
      process.off("unhandledRejection", unhandled);
      setup.restoreEnv();
    }
  });

  it("renders the compact activity card below the editor without remounting during token updates", async () => {
    const setup = await setupExtension();
    try {
      let tokenCount = 12;
      let runningState: any;
      const abortAgent = vi.fn(async () => {});
      const disposeAgent = vi.fn();
      const heartbeatWork = vi.fn();
      (setup.readAgentMock.shutdownReadAgentSession as any).mockImplementation(async (session: any) => { await session?.abort?.(); });
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        runningState = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now() - 1000,
          tokensUsed: 12,
          status: "thinking",
          recentEvents: ["assistant: secret agent thought"],
          lastActivityAt: Date.now(),
          role: member.role,
          model: member.model,
          thinking: member.thinking,
          modelSlot: member.modelSlot,
          latestAssistantSnippet: "secret agent thought",
          latestProgress: "Reviewing focused test coverage",
          progressUpdatedAt: Date.now(),
          heartbeatTimer: setInterval(heartbeatWork, 5_000),
          session: {
            abort: abortAgent,
            dispose: disposeAgent,
            getSessionStats: () => ({ tokens: { total: tokenCount } }),
          },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), runningState);
      });
      const ctx = makeCtx(setup.root, "status-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      const abort = new AbortController().signal;

      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Think about this",
        cwd: setup.root,
        model_slot: "reading-default",
      }, abort, undefined, ctx);
      await vi.advanceTimersByTimeAsync(100);

      const widgetCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      expect(widgetCall?.[2]).toEqual({ placement: "belowEditor" });
      const requestRender = vi.fn();
      const widget = widgetCall![1]({ requestRender });
      const initialRendered = widget.render(160).join("\n");
      expect(initialRendered).toContain("agent activity");
      expect(initialRendered).toMatch(/\(reader\) model\/high · read-review · 1s · 12 tok · Reviewing focused test coverage\.{1,3}/);
      expect(initialRendered).not.toContain("secret agent thought");
      expect(initialRendered).not.toContain("reader read thinking");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("01-pi-extended-teams-read", undefined);

      const firstWidgetCallIndex = ctx.ui.setWidget.mock.calls.indexOf(widgetCall!);
      tokenCount = 2_300_000;
      runningState.latestProgress = "Writing the final report";
      runningState.progressUpdatedAt = Date.now();
      await vi.advanceTimersByTimeAsync(1_000);

      let updatedRendered = widget.render(160).join("\n");
      expect(updatedRendered).toContain("Reviewing focused test coverage");
      expect(updatedRendered).not.toContain("Writing the final report");
      await vi.advanceTimersByTimeAsync(1_000);
      updatedRendered = widget.render(160).join("\n");
      expect(updatedRendered).toMatch(/\(reader\) model\/high · read-review · 3s · 2\.3M tok · Writing the final report\.{1,3}/);
      expect(requestRender).toHaveBeenCalled();
      expect(ctx.ui.setWidget.mock.calls.filter((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function")).toHaveLength(1);
      expect(ctx.ui.setWidget.mock.calls.slice(firstWidgetCallIndex + 1).some((call: any[]) => call[0] === "01-pi-extended-teams-readers" && call[1] === undefined)).toBe(false);

      for (const handler of setup.eventHandlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
      expect(ctx.ui.setWidget).toHaveBeenCalledWith("01-pi-extended-teams-readers", undefined);
      expect(abortAgent).toHaveBeenCalledOnce();
      expect(disposeAgent).toHaveBeenCalledOnce();
      const callCountAfterShutdown = ctx.ui.setWidget.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(callCountAfterShutdown);
      expect(heartbeatWork).not.toHaveBeenCalled();
    } finally {
      setup.restoreEnv();
    }
  });

  it("adds active depth-1 read helper counts to writer rows without changing global counts", async () => {
    const setup = await setupExtension();
    try {
      const runtime = await import("../src/utils/runtime.js");
      let writerState: any;
      let activeHelperState: any;
      let runningAgents!: Map<string, any>;
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        runningAgents = options.runningReadAgents;
        const state = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now() - 1_000,
          tokensUsed: 25,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          role: member.role,
          model: member.model,
          thinking: member.thinking,
          modelSlot: member.modelSlot,
          latestProgress: "Implementing parent work",
          session: { getSessionStats: () => ({ tokens: { total: 25 } }) },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), state);
        if (member.name === "writer") writerState = state;
      });

      const ctx = makeCtx(setup.root, "nested-helper-activity-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "writer",
        prompt: "Implement a bounded feature",
        cwd: setup.root,
        model_slot: "write-critical",
        allow_nested_read_agents: true,
      }, new AbortController().signal, undefined, ctx);

      const teamName = "session-nested-helper-activity-session";
      const writer = (await setup.teams.readConfig(teamName)).members.find((member: any) => member.name === "writer")!;
      const helperBase = {
        agentType: "teammate",
        role: "read" as const,
        model: "provider/model",
        thinking: "high" as const,
        modelSlot: "read-review",
        joinedAt: Date.now() - 500,
        tmuxPaneId: "",
        cwd: setup.root,
        subscriptions: [],
        delegationDepth: 1,
        allowNestedReadAgents: false,
        parentAgentName: "writer",
        parentLifecycleRunId: writer.lifecycleRunId,
        requestedBy: "writer",
        helperKind: "read_helper" as const,
      };
      const activeHelper: any = { ...helperBase, agentId: "active-helper@team", name: "active-helper" };
      const runtimeHelper: any = { ...helperBase, agentId: "runtime-helper@team", name: "runtime-helper" };
      const completedHelper: any = { ...helperBase, agentId: "completed-helper@team", name: "completed-helper", isActive: false };
      await setup.teams.addMember(teamName, activeHelper);
      await setup.teams.addMember(teamName, runtimeHelper);
      await setup.teams.addMember(teamName, completedHelper);

      activeHelperState = {
        runId: activeHelper.lifecycleRunId,
        name: activeHelper.name,
        teamName,
        startedAt: Date.now() - 500,
        tokensUsed: 5,
        status: "working",
        recentEvents: [],
        lastActivityAt: Date.now(),
        role: "read",
        model: activeHelper.model,
        thinking: activeHelper.thinking,
        modelSlot: activeHelper.modelSlot,
        session: { getSessionStats: () => ({ tokens: { total: 5 } }) },
      };
      runningAgents.set(`${teamName}:${activeHelper.name}`, activeHelperState);
      await runtime.writeRuntimeStatus(teamName, runtimeHelper.name, runtimeHelper.lifecycleRunId!, {
        ready: true,
        startedAt: Date.now() - 500,
        lastHeartbeatAt: Date.now(),
        currentAction: "working",
        tokensUsed: 7,
      });

      await vi.advanceTimersByTimeAsync(1_200);
      const widgetCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      const widget = widgetCall![1]({ requestRender: vi.fn() });
      const activeRendered = widget.render(180).join("\n");
      expect(activeRendered).toContain("3 active · 2 read · 1 write");
      expect(activeRendered).toMatch(/\(writer\) model\/xhigh · \+2 · write-critical · .* · 25 tok · Implementing parent work\.{1,3}/);
      expect(activeRendered).not.toContain("completed-helper");

      // Failed helpers remain in their live runner/runtime records until async
      // teardown, but must stop contributing to the parent's helper suffix.
      activeHelperState.lastError = { message: "local helper failed", timestamp: Date.now() };
      await runtime.writeRuntimeStatus(teamName, runtimeHelper.name, runtimeHelper.lifecycleRunId!, {
        lastHeartbeatAt: Date.now(),
        lastError: { message: "runtime helper failed", timestamp: Date.now() },
      });
      await vi.advanceTimersByTimeAsync(1_200);
      const failedRendered = widget.render(180).join("\n");
      expect(failedRendered).toContain("3 active · 2 read · 1 write");
      expect(failedRendered).not.toContain("(writer) model/xhigh · +");

      activeHelperState.teardownState = "finalized";
      await runtime.writeRuntimeStatus(teamName, runtimeHelper.name, runtimeHelper.lifecycleRunId!, {
        lastHeartbeatAt: Date.now() - runtime.HEARTBEAT_STALE_MS - 1,
      });
      writerState.latestProgress = undefined;
      await vi.advanceTimersByTimeAsync(1_200);

      const finishedRendered = widget.render(180).join("\n");
      expect(finishedRendered).toContain("1 active · 1 write");
      expect(finishedRendered).not.toContain(" read");
      expect(finishedRendered).not.toContain("(writer) +");
      expect(finishedRendered).not.toContain("active-helper");
      expect(finishedRendered).not.toContain("runtime-helper");
    } finally {
      setup.restoreEnv();
    }
  });

  it("removes a failed helper suffix while a real rejected-prompt run remains live for delivery", async () => {
    const setup = await setupExtension();
    try {
      let writerState: any;
      let runningAgents!: Map<string, any>;
      let readAgentOptions: any;
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        runningAgents = options.runningReadAgents;
        readAgentOptions = options;
        writerState = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now() - 1_000,
          tokensUsed: 25,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          role: member.role,
          model: member.model,
          thinking: member.thinking,
          modelSlot: member.modelSlot,
          latestProgress: "Implementing parent work",
          session: { getSessionStats: () => ({ tokens: { total: 25 } }) },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), writerState);
      });

      const ctx = makeCtx(setup.root, "real-helper-failure-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "writer",
        prompt: "Implement a bounded feature",
        cwd: setup.root,
        model_slot: "write-critical",
        allow_nested_read_agents: true,
      }, new AbortController().signal, undefined, ctx);

      const teamName = "session-real-helper-failure-session";
      const writer = (await setup.teams.readConfig(teamName)).members.find((member: any) => member.name === "writer")!;
      const helper: any = {
        agentId: `failing-helper@${teamName}`,
        name: "failing-helper",
        agentType: "teammate",
        role: "read",
        model: "provider/model",
        thinking: "high",
        modelSlot: "read-review",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: setup.root,
        subscriptions: [],
        delegationDepth: 1,
        allowNestedReadAgents: false,
        parentAgentName: "writer",
        parentLifecycleRunId: writer.lifecycleRunId,
        requestedBy: "writer",
        helperKind: "read_helper",
      };
      await setup.teams.addMember(teamName, helper);

      let markPromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
      let rejectPrompt!: (error: Error) => void;
      const promptGate = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
      const session = {
        messages: [],
        getSessionStats: vi.fn(() => ({ tokens: { total: 5 }, cost: 0 })),
        subscribe: vi.fn(),
        prompt: vi.fn(() => {
          markPromptStarted();
          return promptGate;
        }),
        bindExtensions: vi.fn(async () => {}),
        sendUserMessage: vi.fn(async () => {}),
        isStreaming: true,
        hasExtensionHandlers: vi.fn(() => false),
        extensionRunner: { emit: vi.fn(async () => {}) },
        clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
        abort: vi.fn(async () => {}),
        dispose: vi.fn(),
      };
      vi.doMock("./internal/pi-runtime-api.js", () => ({
        loadPiRuntimeApi: async () => ({
          createAgentSession: vi.fn(async () => ({ session })),
          DefaultResourceLoader: class {
            async reload() {}
            getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
          },
          getAgentDir: () => "/mock-agent-dir",
          SettingsManager: {
            create: vi.fn(() => ({
              getGlobalSettings: () => ({}),
              getProjectSettings: () => ({}),
            })),
          },
          SessionManager: { inMemory: vi.fn(() => ({})) },
        }),
      }));
      const actualReadAgent = await vi.importActual<typeof import("./agents/read-agent.js")>("./agents/read-agent.js");
      let markFailureDeliveryStarted!: () => void;
      const failureDeliveryStarted = new Promise<void>((resolve) => { markFailureDeliveryStarted = resolve; });
      let releaseFailureDelivery!: () => void;
      const failureDeliveryGate = new Promise<void>((resolve) => { releaseFailureDelivery = resolve; });
      const helperOptions = {
        ...readAgentOptions,
        deliverMessageToActiveAgent: vi.fn(async () => {
          markFailureDeliveryStarted();
          await failureDeliveryGate;
          return true;
        }),
        renderLeadInboxStatus: vi.fn(async () => {}),
        notifyLeadOfInboxReports: vi.fn(async () => {}),
        createResourcePlan: vi.fn(async () => ({
          selectionMode: "default" as const,
          extensionPaths: [],
          extensions: [],
          diagnostics: [],
          skills: "all" as const,
          trust: { cwd: setup.root, projectTrusted: true },
        })),
      };

      const run = actualReadAgent.runReadAgentInProcess(teamName, helper, "fail after starting", ctx, helperOptions);
      await promptStarted;
      await vi.advanceTimersByTimeAsync(1_200);
      const widgetCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      const widget = widgetCall![1]({ requestRender: vi.fn() });
      expect(widget.render(180).join("\n")).toMatch(/\(writer\) model\/xhigh · \+1 · write-critical/);

      rejectPrompt(new Error("provider rejected prompt"));
      await failureDeliveryStarted;
      await vi.advanceTimersByTimeAsync(1_200);
      const liveFailureState = runningAgents.get(`${teamName}:failing-helper`);
      expect(liveFailureState?.lastError).toMatchObject({ message: "provider rejected prompt" });
      expect(runningAgents.get(`${teamName}:failing-helper`)).toBe(liveFailureState);
      const failedRendered = widget.render(180).join("\n");
      expect(failedRendered).toContain("2 active · 1 read · 1 write");
      expect(failedRendered).not.toMatch(/\(writer\) model\/xhigh · \+/);

      releaseFailureDelivery();
      await run;
      expect(runningAgents.has(`${teamName}:failing-helper`)).toBe(false);
      expect(writerState.latestProgress).toBe("Implementing parent work");
    } finally {
      setup.restoreEnv();
    }
  });

  it("quarantines a parent-shutdown delivery timeout and defers child cleanup", async () => {
    const setup = await setupExtension();
    try {
      let settleDelivery!: () => void;
      const rawDelivery = new Promise<void>((resolve) => { settleDelivery = resolve; });
      const disposeAgent = vi.fn();
      const emitShutdown = vi.fn(async () => {});
      let runningState: any;
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        runningState = {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now(),
          tokensUsed: 0,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          role: member.role,
          model: member.model,
          thinking: member.thinking,
          modelSlot: member.modelSlot,
          acceptingMessages: true,
          messageDeliveryClosed: false,
          messageDeliveryTail: rawDelivery,
          session: {
            hasExtensionHandlers: vi.fn(() => true),
            extensionRunner: { emit: emitShutdown },
            clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
            abort: vi.fn(async () => {}),
            dispose: disposeAgent,
            getSessionStats: () => ({ tokens: { total: 0 } }),
          },
        };
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), runningState);
      });
      const ctx = makeCtx(setup.root, "shutdown-timeout-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Inspect this",
        cwd: setup.root,
        model_slot: "read-review",
      }, new AbortController().signal, undefined, ctx);

      const shutdown = Promise.all(
        (setup.eventHandlers.get("session_shutdown") ?? []).map(handler => handler({ reason: "reload" }, ctx))
      );
      await vi.advanceTimersByTimeAsync(0);

      const teamName = "session-shutdown-timeout-session";
      const stoppingMember = (await setup.teams.readConfig(teamName)).members.find((item: any) => item.name === "reader");
      expect(stoppingMember?.isActive).toBe(false);
      const messaging = await import("../src/utils/messaging.js");
      await expect(
        messaging.sendPlainMessageIfRunning(teamName, "team-lead", "reader", "late message", "Late")
      ).rejects.toThrow("lifecycle-quarantined");

      await vi.advanceTimersByTimeAsync(2_500);
      await shutdown;
      expect(runningState.teardownState).toBe("quarantined");
      expect((await setup.teams.readConfig(teamName)).members.map((item: any) => item.name)).toEqual(["team-lead", "reader"]);
      expect(emitShutdown).toHaveBeenCalledOnce();
      expect(emitShutdown).toHaveBeenCalledWith({ type: "session_shutdown", reason: "reload" });
      expect(disposeAgent).not.toHaveBeenCalled();

      // A repeated parent shutdown consumes the cached bounded proof and does
      // not wait for or advance the raw teardown timer.
      const repeatedShutdown = Promise.all(
        (setup.eventHandlers.get("session_shutdown") ?? []).map(handler => handler({ reason: "quit" }, ctx))
      );
      await repeatedShutdown;
      expect(emitShutdown).toHaveBeenCalledOnce();
      expect(disposeAgent).not.toHaveBeenCalled();

      settleDelivery();
      await runningState.teardownFinalizationPromise;
      expect((await setup.teams.readConfig(teamName)).members.map((item: any) => item.name)).toEqual(["team-lead"]);
      expect(emitShutdown).toHaveBeenCalledOnce();
      expect(disposeAgent).toHaveBeenCalledOnce();
    } finally {
      setup.restoreEnv();
    }
  });

  it("does not dispose agents when extension shutdown cannot close persisted admission", async () => {
    const setup = await setupExtension();
    try {
      const abortAgent = vi.fn(async () => {});
      const disposeAgent = vi.fn();
      const emitShutdown = vi.fn(async () => {});
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now(),
          tokensUsed: 0,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          acceptingMessages: true,
          messageDeliveryClosed: false,
          session: {
            hasExtensionHandlers: vi.fn(() => true),
            extensionRunner: { emit: emitShutdown },
            clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
            abort: abortAgent,
            dispose: disposeAgent,
            getSessionStats: () => ({ tokens: { total: 0 } }),
          },
        });
      });
      const ctx = makeCtx(setup.root, "shutdown-close-failure-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Inspect this",
        cwd: setup.root,
        model_slot: "read-review",
      }, new AbortController().signal, undefined, ctx);

      const paths = await import("../src/utils/paths.js");
      const configPath = paths.configPath("session-shutdown-close-failure-session");
      fs.writeFileSync(configPath, "{ malformed config");
      const shutdown = Promise.all(
        (setup.eventHandlers.get("session_shutdown") ?? []).map(handler => handler({ reason: "reload" }, ctx))
      );
      await expect(shutdown).rejects.toThrow(
        "Could not close 1 agent recipient(s) during extension shutdown"
      );

      expect(fs.readFileSync(configPath, "utf-8")).toBe("{ malformed config");
      expect(emitShutdown).not.toHaveBeenCalled();
      expect(abortAgent).not.toHaveBeenCalled();
      expect(disposeAgent).not.toHaveBeenCalled();
    } finally {
      setup.restoreEnv();
    }
  });

  it("opens a full-window live agent view with down and returns to main with up", async () => {
    const setup = await setupExtension();
    try {
      let followedComponent: any;
      const done = vi.fn();
      const baseEditor = { getText: vi.fn(() => ""), handleInput: vi.fn() };
      const ctx = makeCtx(setup.root, "follow-session");
      ctx.ui.getEditorComponent.mockReturnValue(() => baseEditor);
      ctx.ui.custom.mockImplementation(async (factory: any, options: any) => {
        expect(options).toMatchObject({
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
        });
        followedComponent = factory({ terminal: { rows: 30 }, requestRender: vi.fn() }, {}, {}, done);
      });
      setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
        options.runningReadAgents.set(options.readAgentKey(teamName, member.name), {
          runId: member.lifecycleRunId,
          name: member.name,
          teamName,
          startedAt: Date.now() - 2_000,
          tokensUsed: 88,
          status: "working",
          recentEvents: [],
          lastActivityAt: Date.now(),
          role: member.role,
          model: member.model,
          thinking: member.thinking,
          modelSlot: member.modelSlot,
          latestProgress: "Inspecting the codebase",
          session: {
            messages: [{ role: "assistant", content: [{ type: "text", text: "Live agent output" }] }],
            getSessionStats: () => ({ tokens: { total: 88 } }),
          },
        });
      });

      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Inspect this",
        cwd: setup.root,
        model_slot: "read-review",
      }, new AbortController().signal, undefined, ctx);

      const editorFactory = ctx.ui.setEditorComponent.mock.calls.at(-1)?.[0];
      const editor = editorFactory({}, {}, {});
      editor.handleInput("\x1b[B");

      expect(ctx.ui.custom).toHaveBeenCalledOnce();
      expect(followedComponent.render(140).join("\n")).toContain("Live agent output");
      followedComponent.handleInput("\x1b[A");
      expect(done).toHaveBeenCalledOnce();
      followedComponent.dispose();
    } finally {
      setup.restoreEnv();
    }
  });

  it("clears the activity card instead of showing stale ready runtime JSON", async () => {
    const setup = await setupExtension();
    try {
      const runtime = await import("../src/utils/runtime.js");
      setup.readAgentMock.runReadAgentInProcess.mockImplementation(() => {});
      const ctx = makeCtx(setup.root, "runtime-only-status-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      const abort = new AbortController().signal;

      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "reader",
        prompt: "Think about this",
        cwd: setup.root,
        model_slot: "reading-default",
      }, abort, undefined, ctx);

      const now = Date.now();
      const readerRunId = (await setup.teams.readConfig("session-runtime-only-status-session")).members
        .find((member: any) => member.name === "reader")!.lifecycleRunId!;
      await runtime.writeRuntimeStatus("session-runtime-only-status-session", "reader", readerRunId, {
        pid: process.pid,
        startedAt: now - 120_000,
        lastHeartbeatAt: now - runtime.HEARTBEAT_STALE_MS - 1_000,
        ready: true,
        currentAction: "thinking",
        tokensUsed: 7,
        latestProgress: "Tracing runtime visibility",
        progressUpdatedAt: now - 5_000,
      });
      await vi.advanceTimersByTimeAsync(1_200);

      const latestActivityCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers");
      expect(latestActivityCall?.[1]).toBeUndefined();
      expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function")).toBe(false);
    } finally {
      setup.restoreEnv();
    }
  });

  it("renders an orphaned occupied tombstone as inactive quarantine, then clears the latest activity widget after matching release", async () => {
    const setup = await setupExtension();
    try {
      const lifecycle = await import("../src/utils/lifecycle-tombstone.js");
      const paths = await import("../src/utils/paths.js");
      const teamName = "session-tombstone-activity-session";
      setup.teams.createTeam(teamName, "tombstone-activity-session", "lead", "", "provider/model");
      fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
        pid: process.pid,
        sessionId: "tombstone-activity-session",
        startedAt: Date.now(),
      }));
      await lifecycle.withLifecycleTombstoneLock(teamName, "orphan-writer", async lock => {
        lock.occupy({
          team: teamName,
          agent: "orphan-writer",
          runId: "orphan-run",
          role: "write",
          reason: "quit",
          extensionInstanceId: "index-production-test",
        });
      });
      const ctx = makeCtx(setup.root, "tombstone-activity-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      await vi.advanceTimersByTimeAsync(1_200);

      const mountedActivityCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      const widget = mountedActivityCall![1]({ requestRender: vi.fn() });
      const rendered = widget.render(160).join("\n");
      expect(rendered).toContain("orphan-writer");
      expect(rendered).toContain("inactive");
      expect(rendered).toContain("quarantined");
      expect(rendered).toContain("run orphan-run");

      await lifecycle.withLifecycleTombstoneLock(teamName, "orphan-writer", async lock => {
        expect(lock.clearMatching("orphan-run")).toBe(true);
      });
      await vi.advanceTimersByTimeAsync(1_200);
      const latestActivityCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers");
      expect(latestActivityCall?.[1]).toBeUndefined();
    } finally {
      setup.restoreEnv();
    }
  });

  it.each(["stopping", "quarantined", "persistence_failed", "finalized"] as const)(
    "excludes %s read teardown state from the active card and clears it",
    async (teardownState) => {
      const setup = await setupExtension();
      try {
        setup.readAgentMock.runReadAgentInProcess.mockImplementation((teamName: string, member: any, _prompt: string, _ctx: any, options: any) => {
          options.runningReadAgents.set(options.readAgentKey(teamName, member.name), {
            runId: member.lifecycleRunId,
            name: member.name,
            teamName,
            startedAt: Date.now(),
            tokensUsed: 0,
            status: "finishing",
            recentEvents: [],
            lastActivityAt: Date.now(),
            role: member.role,
            teardownState,
          });
        });
        const ctx = makeCtx(setup.root, `teardown-${teardownState}-session`);
        for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
        writeFavoriteLevels(setup.root);
        await setup.tools.get("spawn_agent")!.execute("spawn", {
          name: "reader",
          prompt: "Think about this",
          cwd: setup.root,
          model_slot: "reading-default",
        }, new AbortController().signal, undefined, ctx);
        await vi.advanceTimersByTimeAsync(100);

        expect(ctx.ui.setWidget).toHaveBeenCalledWith("01-pi-extended-teams-readers", undefined);
        expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function")).toBe(false);
      } finally {
        setup.restoreEnv();
      }
    }
  );

  it("shows fresh runtime and active legacy panes while omitting inactive live panes", async () => {
    const setup = await setupExtension();
    try {
      const runtime = await import("../src/utils/runtime.js");
      setup.readAgentMock.runReadAgentInProcess.mockImplementation(() => {});
      const ctx = makeCtx(setup.root, "activity-classification-session");
      for (const handler of setup.eventHandlers.get("session_start") ?? []) await handler({}, ctx);
      writeFavoriteLevels(setup.root);
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "fresh-reader",
        prompt: "Think about this",
        cwd: setup.root,
        model_slot: "reading-default",
      }, new AbortController().signal, undefined, ctx);

      const teamName = "session-activity-classification-session";
      const now = Date.now();
      await setup.teams.addMember(teamName, {
        agentId: "legacy-writer@team",
        name: "legacy-writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "high",
        modelSlot: "writing-hard",
        joinedAt: now - 60_000,
        tmuxPaneId: "%legacy",
        cwd: setup.root,
        subscriptions: [],
        isActive: true,
      });
      await setup.teams.addMember(teamName, {
        agentId: "runtime-writer@team",
        name: "runtime-writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "high",
        modelSlot: "writing-hard",
        joinedAt: now - 60_000,
        tmuxPaneId: "",
        cwd: setup.root,
        subscriptions: [],
        isActive: true,
      });
      await setup.teams.addMember(teamName, {
        agentId: "inactive-writer@team",
        name: "inactive-writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        joinedAt: now - 60_000,
        tmuxPaneId: "%inactive",
        cwd: setup.root,
        subscriptions: [],
        isActive: false,
      });
      const activityConfig = await setup.teams.readConfig(teamName);
      const runIdFor = (name: string) => activityConfig.members.find((member: any) => member.name === name)!.lifecycleRunId!;
      await runtime.writeRuntimeStatus(teamName, "fresh-reader", runIdFor("fresh-reader"), {
        ready: true,
        startedAt: now - 60_000,
        lastHeartbeatAt: now,
        currentAction: "thinking",
        latestProgress: "Fresh runtime work",
      });
      await runtime.writeRuntimeStatus(teamName, "runtime-writer", runIdFor("runtime-writer"), {
        ready: true,
        startedAt: now - 60_000,
        lastHeartbeatAt: now,
        currentAction: "working",
        latestProgress: "Canonical runtime slot",
      });
      await runtime.writeRuntimeStatus(teamName, "legacy-writer", runIdFor("legacy-writer"), {
        ready: true,
        startedAt: now - 60_000,
        lastHeartbeatAt: now - runtime.HEARTBEAT_STALE_MS - 1,
        currentAction: "working",
      });
      await vi.advanceTimersByTimeAsync(1_200);

      const widgetCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      const widget = widgetCall![1]({ requestRender: vi.fn() });
      const rendered = widget.render(160).join("\n");
      expect(rendered).toContain("3 active · 1 read · 2 write");
      expect(rendered).toContain("fresh-reader");
      expect(rendered).toContain("Fresh runtime work");
      expect(rendered).toContain("runtime-writer");
      expect(rendered).toContain("Canonical runtime slot");
      expect(rendered).toContain("legacy-writer");
      expect(rendered).toContain("write-system");
      expect(rendered).not.toContain("writing-hard");
      expect(rendered).not.toContain("inactive-writer");
    } finally {
      setup.restoreEnv();
    }
  });

  it("spawn_swarm_agents starts a batch with default and per-agent levels", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      const ctx = makeCtx(setup.root, "swarm-session");
      const abort = new AbortController().signal;

      const result = await setup.tools.get("spawn_swarm_agents")!.execute("swarm", {
        defaults: { cwd: setup.root, model_slot: "read-review" },
        agents: [
          { name: "one", prompt: "Inspect one" },
          { name: "two", prompt: "Inspect two", model_slot: "read-critical" },
        ],
      }, abort, undefined, ctx);

      expect(result.details.spawned).toHaveLength(2);
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledTimes(2);
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "one", thinking: "high", modelSlot: "read-review" });
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "two", thinking: "xhigh", modelSlot: "read-critical" });
    } finally {
      setup.restoreEnv();
    }
  });
});
