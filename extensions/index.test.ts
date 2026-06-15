import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

const testRoot = path.join(os.tmpdir(), "pi-extended-teams-extension-" + Date.now());

function makeCtx(cwd: string) {
  return {
    cwd,
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn() },
    isIdle: vi.fn(() => true),
    shutdown: vi.fn(),
  };
}

async function setupExtension(env: Record<string, string | undefined> = {}) {
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

  return { root, terminal, tools, pi, eventHandlers, paths, teams, claims, restoreEnv: () => { process.env = originalEnv; } };
}

describe("extension integration", () => {
  beforeEach(() => {
    vi.useRealTimers();
    if (!fs.existsSync(testRoot)) fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/adapters/terminal-registry");
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true });
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
