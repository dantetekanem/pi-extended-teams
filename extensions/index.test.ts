import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Key } from "@mariozechner/pi-tui";

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

  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, any>();
  const eventHandlers = new Map<string, Function[]>();
  const extensionEventHandlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerShortcut: vi.fn(),
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
      "reading-fast": { model: "provider/model", thinking: "low" },
      "reading-default": { model: "provider/model", thinking: "high" },
      "reading-hard": { model: "provider/model", thinking: "xhigh" },
      "writing-basic": { model: "provider/model", thinking: "high" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
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

  it("does not expose report_progress in the lead session", async () => {
    const setup = await setupExtension();
    try {
      expect(setup.tools.has("report_progress")).toBe(false);
    } finally {
      setup.restoreEnv();
    }
  });

  it("report_progress updates runtime-backed agents without inbox or lead-turn side effects", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    try {
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
        "No agent levels are configured. Define them with /agents-favorite-models before spawning agents. See TIPS.md for level examples.",
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
        model_slot: "writing-hard",
      }, abort, undefined, ctx);

      expect(result.details).toMatchObject({ name: "editor", role: "write", mode: "in-process", terminalId: null, session: "session-edit-session", modelSlot: "writing-hard" });
      expect(setup.terminal.spawn).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledWith(
        "session-edit-session",
        expect.objectContaining({ name: "editor", role: "write", model: "provider/model", thinking: "xhigh", modelSlot: "writing-hard" }),
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

  it("emits only the minimal correlated nested-agent progress event", async () => {
    const setup = await setupExtension();
    try {
      writeFavoriteLevels(setup.root);
      const ctx = makeCtx(setup.root, "progress-event-session");
      await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "planner-private",
        prompt: "Inspect the repository",
        cwd: setup.root,
        model_slot: "reading-hard",
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
        model_slot: "reading-default",
      }, abort, undefined, ctx);

      const messaging = await import("../src/utils/messaging.js");
      const targetTeamName = "session-test-session";
      await messaging.sendPlainMessage(targetTeamName, "reader", "team-lead", "first report", "First report");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(setup.pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(setup.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "pi-extended-teams-wake", content: expect.stringContaining("Check your agent messages now"), display: false }),
        { triggerTurn: true, deliverAs: "followUp" }
      );
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
          runId: "reader-run",
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
      expect(initialRendered).toMatch(/\(reader\) model\/high · reading-default · 1s · 12 tok · Reviewing focused test coverage\.{1,3}/);
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
      expect(updatedRendered).toMatch(/\(reader\) model\/high · reading-default · 3s · 2\.3M tok · Writing the final report\.{1,3}/);
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
          runId: "follow-run",
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
        model_slot: "reading-default",
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

  it("keeps runtime-only agent progress visible in the below-editor activity card after a stale heartbeat", async () => {
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
      await runtime.writeRuntimeStatus("session-runtime-only-status-session", "reader", {
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

      const widgetCall = [...ctx.ui.setWidget.mock.calls]
        .reverse()
        .find((call: any[]) => call[0] === "01-pi-extended-teams-readers" && typeof call[1] === "function");
      expect(widgetCall?.[2]).toEqual({ placement: "belowEditor" });
      const widget = widgetCall![1]({ requestRender: vi.fn() });
      const rendered = widget.render(160).join("\n");
      expect(rendered).toMatch(/\(reader\) model\/high · reading-default · 2m01s · 7 tok · Tracing runtime visibility\.{1,3}/);
      expect(rendered).not.toContain("heartbeat stale");
      expect(rendered).not.toContain("reader read stale");
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
        defaults: { cwd: setup.root, model_slot: "reading-default" },
        agents: [
          { name: "one", prompt: "Inspect one" },
          { name: "two", prompt: "Inspect two", model_slot: "reading-hard" },
        ],
      }, abort, undefined, ctx);

      expect(result.details.spawned).toHaveLength(2);
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledTimes(2);
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "one", thinking: "high", modelSlot: "reading-default" });
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "two", thinking: "xhigh", modelSlot: "reading-hard" });
    } finally {
      setup.restoreEnv();
    }
  });
});
