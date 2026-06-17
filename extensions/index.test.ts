import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

const testRoot = path.join(os.tmpdir(), "pi-extended-teams-extension-" + Date.now());

function makeCtx(cwd: string, sessionId = "test-session") {
  return {
    cwd,
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
    },
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), custom: vi.fn() },
    isIdle: vi.fn(() => true),
    shutdown: vi.fn(),
  };
}

async function setupExtension(env: Record<string, string | undefined> = {}, options: { mockReadAgent?: boolean } = {}) {
  vi.resetModules();
  const originalEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const terminal = {
    spawn: vi.fn(() => `%${terminal.spawn.mock.calls.length}`),
    kill: vi.fn(),
    isAlive: vi.fn(() => true),
    setTitle: vi.fn(),
  };

  vi.doMock("../src/adapters/terminal-registry", () => ({
    getTerminalAdapter: () => terminal,
  }));

  const readAgentMock = {
    runReadAgentInProcess: vi.fn(),
    shutdownReadAgentSession: vi.fn(async () => {}),
  };
  if (options.mockReadAgent) {
    vi.doMock("./agents/read-agent.js", () => readAgentMock);
  }

  const extensionModule = await import("./index.js") as any;
  const extension = extensionModule.default;
  const paths = await import("../src/utils/paths.js");
  const teams = await import("../src/utils/teams.js");
  const claims = await import("../src/utils/claims.js");

  const root = fs.mkdtempSync(path.join(testRoot, "case-"));
  const teamsRoot = path.join(root, "teams");
  const tasksRoot = path.join(root, "tasks");
  fs.mkdirSync(teamsRoot, { recursive: true });
  fs.mkdirSync(tasksRoot, { recursive: true });

  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(tasksRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "writeQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "write-queue.json"));
  vi.spyOn(paths, "readHelperQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "read-helper-queue.json"));
  vi.spyOn(paths, "sharedMemoryPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "shared-memory.json"));
  vi.spyOn(paths, "leadSessionPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lead-session.json"));

  const tools = new Map<string, RegisteredTool>();
  const eventHandlers = new Map<string, Function[]>();
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    on: vi.fn((eventName: string, handler: Function) => {
      eventHandlers.set(eventName, [...(eventHandlers.get(eventName) || []), handler]);
    }),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
  };

  extension(pi as any);

  return { root, terminal, tools, pi, eventHandlers, paths, teams, claims, readAgentMock, restoreEnv: () => { process.env = originalEnv; } };
}

describe("extension integration", () => {
  beforeEach(() => {
    vi.useRealTimers();
    if (!fs.existsSync(testRoot)) fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/adapters/terminal-registry");
    vi.doUnmock("./agents/read-agent.js");
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true });
  });

  it("does not rediscover a lead team from another Pi session", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root, "current-session");
    setup.teams.createTeam("foreign-team", "session", "lead", "", "provider/model");
    fs.writeFileSync(setup.paths.leadSessionPath("foreign-team"), JSON.stringify({
      pid: process.pid,
      sessionId: "other-session",
      startedAt: Date.now(),
    }));

    for (const handler of setup.eventHandlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    const teamCommand = setup.pi.registerCommand.mock.calls.find((call: any[]) => call[0] === "team")?.[1];
    await teamCommand.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No current team. Pass a team name: /team <name>", "warning");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    setup.restoreEnv();
  });

  it("rediscovers a lead team only when the Pi session id matches", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root, "current-session");
    setup.teams.createTeam("current-team", "session", "lead", "", "provider/model");
    fs.writeFileSync(setup.paths.leadSessionPath("current-team"), JSON.stringify({
      pid: process.pid,
      sessionId: "current-session",
      startedAt: Date.now(),
    }));

    for (const handler of setup.eventHandlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    const teamCommand = setup.pi.registerCommand.mock.calls.find((call: any[]) => call[0] === "team")?.[1];
    await teamCommand.handler("", ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalledWith("No current team. Pass a team name: /team <name>", "warning");
    expect(ctx.ui.custom).toHaveBeenCalled();
    setup.restoreEnv();
    vi.useRealTimers();
  });

  it("spawns inline agents in one team_create call", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("team_create")!.execute("1", {
      team_name: "team",
      default_model: "provider/model",
      agents: [
        { name: "w1", role: "write", prompt: "work 1", cwd: setup.root },
        { name: "w2", role: "write", prompt: "work 2", cwd: setup.root },
      ],
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).toHaveBeenCalledTimes(2);
    expect(result.details.spawned).toHaveLength(2);

    const config = await setup.teams.readConfig("team");
    expect(config.members.map((member: any) => member.name).sort()).toEqual(["team-lead", "w1", "w2"]);
    setup.restoreEnv();
  });

  it("writes write-agent spawn debug events when debug mode is enabled", async () => {
    const setup = await setupExtension({ PI_EXTENDED_TEAMS_DEBUG: "1" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);

      const result = await setup.tools.get("spawn_teammate")!.execute("spawn", {
        team_name: "team",
        name: "writer",
        prompt: "work",
        cwd: setup.root,
        role: "write",
      }, abort, undefined, ctx);

      const debugLogPath = path.join(setup.paths.teamDir("team"), "debug.log");
      const events = fs.readFileSync(debugLogPath, "utf-8").trim().split("\n").map(line => JSON.parse(line));

      expect(result.details.debugLogPath).toBe(debugLogPath);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "write-agent.spawn.request", agentName: "writer", activeWriteCount: 0 }),
        expect.objectContaining({ event: "write-agent.spawn.prepare", agentName: "writer", cwd: setup.root }),
        expect.objectContaining({ event: "write-agent.spawn.success", agentName: "writer", terminalId: "%1" }),
      ]));
      expect(events.find(event => event.event === "write-agent.spawn.prepare")?.command).toContain("--extension");
      expect(events.find(event => event.event === "write-agent.spawn.prepare")?.extensionSource.replace(/\\/g, "/")).toContain("/extensions/index.");
    } finally {
      setup.restoreEnv();
    }
  });

  it("queues the fourth write agent and drains FIFO when a writer shuts down", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    await setup.tools.get("team_create")!.execute("1", {
      team_name: "team",
      default_model: "provider/model",
    }, abort, undefined, ctx);

    for (const name of ["w1", "w2", "w3", "w4"]) {
      await setup.tools.get("spawn_teammate")!.execute("spawn", {
        team_name: "team",
        name,
        prompt: `work ${name}`,
        cwd: setup.root,
        role: "write",
      }, abort, undefined, ctx);
    }

    expect(setup.terminal.spawn).toHaveBeenCalledTimes(3);
    let queue = await setup.tools.get("list_write_queue")!.execute("queue", { team_name: "team" }, abort, undefined, ctx);
    expect(queue.details.queue).toMatchObject([{ name: "w4" }]);

    await setup.tools.get("process_shutdown_approved")!.execute("shutdown", {
      team_name: "team",
      agent_name: "w1",
    }, abort, undefined, ctx);

    expect(setup.terminal.kill).toHaveBeenCalledWith("%1");
    expect(setup.terminal.spawn).toHaveBeenCalledTimes(4);
    queue = await setup.tools.get("list_write_queue")!.execute("queue", { team_name: "team" }, abort, undefined, ctx);
    expect(queue.details.queue).toEqual([]);

    const config = await setup.teams.readConfig("team");
    expect(config.members.map((member: any) => member.name).sort()).toEqual(["team-lead", "w2", "w3", "w4"]);
    setup.restoreEnv();
  });

  it("does not drain queued writers while shutting down the whole team", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    await setup.tools.get("team_create")!.execute("1", {
      team_name: "team",
      default_model: "provider/model",
    }, abort, undefined, ctx);

    for (const name of ["w1", "w2", "w3", "w4"]) {
      await setup.tools.get("spawn_teammate")!.execute("spawn", {
        team_name: "team",
        name,
        prompt: `work ${name}`,
        cwd: setup.root,
        role: "write",
      }, abort, undefined, ctx);
    }

    expect(setup.terminal.spawn).toHaveBeenCalledTimes(3);
    const queue = await setup.tools.get("list_write_queue")!.execute("queue", { team_name: "team" }, abort, undefined, ctx);
    expect(queue.details.queue).toMatchObject([{ name: "w4" }]);

    await setup.tools.get("team_shutdown")!.execute("shutdown", {
      team_name: "team",
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).toHaveBeenCalledTimes(3);
    expect(setup.terminal.kill).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(setup.paths.teamDir("team"))).toBe(false);
    setup.restoreEnv();
  });

  it("teammates request the lead instead of spawning another teammate directly", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    await setup.tools.get("spawn_teammate")!.execute("spawn", {
      team_name: "team",
      name: "helper",
      prompt: "help with investigation",
      cwd: setup.root,
      role: "read",
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).not.toHaveBeenCalled();

    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0]).toMatchObject({
      from: "writer",
      summary: "Agent spawn request from writer for helper",
      color: "yellow",
      read: false,
    });
    expect(inbox[0].text).toContain("Teammates are not allowed to spawn or promote other agents directly.");
    expect(inbox[0].text).toContain("Requested action: spawn_teammate");
    expect(inbox[0].text).toContain("help with investigation");
    setup.restoreEnv();
  });

  it("teammates request the lead instead of creating inline-agent teams", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("team_create")!.execute("create", {
      team_name: "child-team",
      default_model: "provider/model",
      agents: [{ name: "helper", prompt: "help", role: "read", cwd: setup.root }],
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ requested: true, requestedAction: "team_create", teamName: "team" });
    expect(setup.teams.teamExists("child-team")).toBe(false);

    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0].text).toContain("Requested action: team_create");
    expect(inbox[0].text).toContain("child-team");
    setup.restoreEnv();
  });

  it("request_teammate sends a lead-owned spawn request", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("request_teammate")!.execute("request", {
      team_name: "team",
      name: "tester",
      prompt: "verify the change",
      role: "read",
      reason: "Need independent verification",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ requested: true, requestedAction: "spawn_teammate", teamName: "team" });
    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0].text).toContain("Need independent verification");
    expect(inbox[0].text).toContain("verify the change");
    setup.restoreEnv();
  });

  it("teammates request the lead instead of promoting another teammate directly", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("promote_teammate")!.execute("promote", {
      team_name: "team",
      name: "reader",
      prompt: "move this reader into a pane",
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).not.toHaveBeenCalled();
    expect(setup.terminal.kill).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ requested: true, requestedAction: "promote_teammate", teamName: "team" });

    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0].text).toContain("Requested action: promote_teammate");
    expect(inbox[0].text).toContain("move this reader into a pane");
    setup.restoreEnv();
  });

  it("teammates request the lead instead of creating predefined teams directly", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("create_predefined_team")!.execute("create", {
      team_name: "child-team",
      predefined_team: "missing-template",
      cwd: setup.root,
      default_model: "provider/model",
    }, abort, undefined, ctx);

    expect(setup.terminal.spawn).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ requested: true, requestedAction: "create_predefined_team", teamName: "team" });
    expect(setup.teams.teamExists("child-team")).toBe(false);

    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0].text).toContain("Requested action: create_predefined_team");
    expect(inbox[0].text).toContain("missing-template");
    setup.restoreEnv();
  });

  it("check_teammate removes dead write members instead of leaving stale entries", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    setup.terminal.isAlive.mockReturnValue(false);
    setup.teams.createTeam("team", "session", "lead", "", "provider/model");
    await setup.teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%dead",
      cwd: setup.root,
      subscriptions: [],
    });

    const result = await setup.tools.get("check_teammate")!.execute("check", {
      team_name: "team",
      agent_name: "writer",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ alive: false, health: "dead", removedMember: true });
    const config = await setup.teams.readConfig("team");
    expect(config.members.map((member: any) => member.name)).toEqual(["team-lead"]);
    setup.restoreEnv();
  });

  it("dead write members do not consume write-agent capacity", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    setup.terminal.isAlive.mockReturnValue(false);
    setup.teams.createTeam("team", "session", "lead", "", "provider/model");
    for (const name of ["dead1", "dead2", "dead3"]) {
      await setup.teams.addMember("team", {
        agentId: `${name}@team`,
        name,
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        joinedAt: Date.now(),
        tmuxPaneId: `%${name}`,
        cwd: setup.root,
        subscriptions: [],
      });
    }
    setup.terminal.isAlive.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);

    const result = await setup.tools.get("spawn_teammate")!.execute("spawn", {
      team_name: "team",
      name: "writer",
      prompt: "work",
      cwd: setup.root,
      role: "write",
    }, abort, undefined, ctx);

    expect(result.details).toMatchObject({ queued: false, role: "write" });
    expect(setup.terminal.spawn).toHaveBeenCalledTimes(1);
    setup.restoreEnv();
  });

  it("lead request_teammate calls do not send requests to the lead", async () => {
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    const result = await setup.tools.get("request_teammate")!.execute("request", {
      team_name: "team",
      name: "tester",
      prompt: "verify the change",
      role: "read",
    }, abort, undefined, ctx);

    expect(result.details).toEqual({ leadOnly: true });
    expect(fs.existsSync(setup.paths.inboxPath("team", "team-lead"))).toBe(false);
    setup.restoreEnv();
  });

  it("writer request_read_helper queues only and never starts a read agent from the writer process", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" }, { mockReadAgent: true });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      setup.teams.createTeam("team", "session", "lead", "", "provider/model");
      await setup.teams.addMember("team", {
        agentId: "writer@team",
        name: "writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "xhigh",
        joinedAt: Date.now(),
        tmuxPaneId: "%99",
        cwd: setup.root,
        subscriptions: [],
      });

      const result = await setup.tools.get("request_read_helper")!.execute("helper", {
        team_name: "team",
        prompt: "Research this.",
      }, abort, undefined, ctx);

      expect(result.details).toMatchObject({ queued: true, helperName: "writer-reader", requester: "writer" });
      expect(setup.terminal.spawn).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).not.toHaveBeenCalled();
      const config = await setup.teams.readConfig("team");
      expect(config.members.some((member: any) => member.name === "writer-reader")).toBe(false);

      const readHelperQueue = await import("../src/utils/read-helper-queue.js");
      const queue = await readHelperQueue.listReadHelperQueue("team");
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ name: "writer-reader", requester: "writer", prompt: "Research this." });
    } finally {
      setup.restoreEnv();
    }
  });

  it("bottom status tracks active write agents with tmux pane and model details", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      for (const handler of setup.eventHandlers.get("session_start") || []) {
        await handler({}, ctx);
      }

      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);
      await setup.tools.get("spawn_teammate")!.execute("spawn", {
        team_name: "team",
        name: "writer",
        prompt: "work",
        cwd: setup.root,
        role: "write",
        thinking: "xhigh",
      }, abort, undefined, ctx);
      const runtime = await import("../src/utils/runtime.js");
      await runtime.writeRuntimeStatus("team", "writer", {
        currentAction: "working",
        activeToolName: "bash",
        tokensUsed: 88,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

      const widgetCall = ctx.ui.setWidget.mock.calls
        .filter(([key, widget]: any[]) => key === "01-pi-extended-teams-readers" && typeof widget === "function")
        .at(-1);
      expect(widgetCall).toBeTruthy();
      const rendered = widgetCall![1]({}, {}).render(120).join("\n");
      expect(rendered).toContain("team activity");
      expect(rendered).toContain("writer");
      expect(rendered).toContain("write");
      expect(rendered).toContain("%1");
      expect(rendered).toContain("model · xhigh");
      expect(rendered).not.toContain("provider/model");
      expect(rendered).toContain("88 tok");
      expect(rendered).toContain("working: bash");
    } finally {
      setup.restoreEnv();
      vi.useRealTimers();
    }
  });

  it("lead inbox reports do not render a separate or confirmation status box", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      for (const handler of setup.eventHandlers.get("session_start") || []) {
        await handler({}, ctx);
      }

      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);
      const messaging = await import("../src/utils/messaging.js");
      await messaging.sendPlainMessage("team", "writer", "team-lead", "Final report", "Writer done", "green");

      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();

      const duplicateReportWidget = ctx.ui.setWidget.mock.calls
        .filter(([key, widget]: any[]) => key === "02-pi-extended-teams-inbox" && typeof widget === "function")
        .at(-1);
      expect(duplicateReportWidget).toBeUndefined();

      const activityWidget = ctx.ui.setWidget.mock.calls
        .filter(([key, widget]: any[]) => key === "01-pi-extended-teams-readers" && typeof widget === "function")
        .at(-1);
      expect(activityWidget).toBeUndefined();
      expect(ctx.ui.setWidget.mock.calls.flat().join("\n")).not.toContain("done, waiting report confirmation");
      expect(ctx.ui.setWidget.mock.calls.flat().join("\n")).not.toContain("team reports ready");
    } finally {
      setup.restoreEnv();
      vi.useRealTimers();
    }
  });

  it("does not show helper done notices or active-writer acknowledgements as dead agents", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      for (const handler of setup.eventHandlers.get("session_start") || []) {
        await handler({}, ctx);
      }

      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);
      await setup.tools.get("spawn_teammate")!.execute("spawn", {
        team_name: "team",
        name: "writer",
        prompt: "work",
        cwd: setup.root,
        role: "write",
      }, abort, undefined, ctx);
      const messaging = await import("../src/utils/messaging.js");
      await messaging.sendPlainMessage("team", "writer-reader", "team-lead", "Done: sent latest git log line to writer.", "Done", "cyan");
      await messaging.sendPlainMessage("team", "writer", "team-lead", "Received helper report from writer-reader; continuing.", "writer received helper report", "green");

      await vi.advanceTimersByTimeAsync(30000);
      await Promise.resolve();

      const activityWidget = ctx.ui.setWidget.mock.calls
        .filter(([key, widget]: any[]) => key === "01-pi-extended-teams-readers" && typeof widget === "function")
        .at(-1);
      expect(activityWidget).toBeTruthy();
      const rendered = activityWidget![1]({}, {}).render(120).join("\n");
      expect(rendered).toContain("writer");
      expect(rendered).toContain("write");
      expect(rendered).not.toContain("writer-reader");
      expect(rendered).not.toContain("writer done, waiting report confirmation");
      expect(rendered).not.toContain("2 waiting confirmation");
    } finally {
      setup.restoreEnv();
      vi.useRealTimers();
    }
  });

  it("lead runtime drains queued read-helper requests and starts helpers outside the writer process", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension({}, { mockReadAgent: true });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      for (const handler of setup.eventHandlers.get("session_start") || []) {
        await handler({}, ctx);
      }

      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);
      await setup.teams.addMember("team", {
        agentId: "writer@team",
        name: "writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "xhigh",
        joinedAt: Date.now(),
        tmuxPaneId: "%99",
        cwd: setup.root,
        subscriptions: [],
      });

      const readHelperQueue = await import("../src/utils/read-helper-queue.js");
      const queued = await readHelperQueue.enqueueReadHelperRequest("team", {
        requester: "writer",
        name: "writer-reader",
        prompt: "Inspect the handoff contract.",
        cwd: setup.root,
        model: "provider/model",
        thinking: "high",
      });

      await vi.advanceTimersByTimeAsync(5100);

      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledTimes(1);
      expect(setup.terminal.spawn).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledWith(
        "team",
        expect.objectContaining({ name: "writer-reader", role: "read", requestedBy: "writer", helperKind: "read_helper" }),
        expect.stringContaining("you must call send_message to send your full report to 'writer'"),
        ctx,
        expect.objectContaining({ isTeammate: false, agentName: "team-lead" })
      );
      expect(await readHelperQueue.listReadHelperQueue("team")).toEqual([]);

      const config = await setup.teams.readConfig("team");
      expect(config.members.find((member: any) => member.name === "writer-reader")).toMatchObject({
        role: "read",
        requestedBy: "writer",
        helperKind: "read_helper",
      });
      expect(queued.name).toBe("writer-reader");
    } finally {
      setup.restoreEnv();
      vi.useRealTimers();
    }
  });

  it("wakes the idle lead when team reports arrive", async () => {
    vi.useFakeTimers();
    const setup = await setupExtension();
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    try {
      for (const handler of setup.eventHandlers.get("session_start") || []) {
        await handler({}, ctx);
      }

      await setup.tools.get("team_create")!.execute("1", {
        team_name: "team",
        default_model: "provider/model",
      }, abort, undefined, ctx);

      await setup.tools.get("send_message")!.execute("msg", {
        team_name: "team",
        recipient: "team-lead",
        content: "final report",
        summary: "review complete",
      }, abort, undefined, ctx);

      await vi.advanceTimersByTimeAsync(30000);

      // Lead is woken via a hidden custom message (display:false), not a visible
      // user turn, so coordination stays quiet in the transcript.
      expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();
      expect(setup.pi.sendMessage).toHaveBeenCalledTimes(1);
      expect(setup.pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          display: false,
          content: expect.stringContaining("1 team report ready in your inbox for team"),
        }),
        expect.objectContaining({ triggerTurn: true }),
      );

      await vi.advanceTimersByTimeAsync(30000);
      expect(setup.pi.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      setup.restoreEnv();
      vi.useRealTimers();
    }
  });

  it("report_and_exit sends the report, releases claims, removes the member, and shuts down", async () => {
    const setup = await setupExtension({ PI_TEAM_NAME: "team", PI_AGENT_NAME: "writer" });
    const ctx = makeCtx(setup.root);
    const abort = new AbortController().signal;

    setup.teams.createTeam("team", "session", "lead", "", "provider/model");
    await setup.teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%99",
      cwd: setup.root,
      subscriptions: [],
    });
    await setup.claims.claimFiles("team", "writer", ["src/a.ts"]);

    await setup.tools.get("report_and_exit")!.execute("report", {
      team_name: "team",
      content: "done",
      summary: "done summary",
    }, abort, undefined, ctx);

    expect(await setup.claims.listClaims("team")).toEqual([]);
    const config = await setup.teams.readConfig("team");
    expect(config.members.map((member: any) => member.name)).toEqual(["team-lead"]);

    const inboxPath = setup.paths.inboxPath("team", "team-lead");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf-8"));
    expect(inbox[0]).toMatchObject({ from: "writer", text: "done", summary: "done summary" });

    await new Promise(resolve => setTimeout(resolve, 300));
    expect(setup.terminal.kill).toHaveBeenCalledWith("%99");
    expect(ctx.shutdown).toHaveBeenCalled();
    setup.restoreEnv();
  });
});
