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
    sessionManager: { getSessionId: vi.fn(() => sessionId) },
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), custom: vi.fn(), getToolsExpanded: vi.fn(() => false) },
    isIdle: vi.fn(() => true),
    shutdown: vi.fn(),
  };
}

async function setupExtension(env: Record<string, string | undefined> = {}) {
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
  const pi = {
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

describe("extension integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the small public tool surface, /agents command, /team alias, and Alt+Tab shortcut", async () => {
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
      expect(setup.commands.has("agents")).toBe(true);
      expect(setup.commands.has("team")).toBe(true);
      expect(setup.commands.has("agents-favorite-models")).toBe(true);
      expect(setup.commands.get("team")).toBe(setup.commands.get("agents"));
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

  it("/agents opens an empty implicit current-session panel", async () => {
    const setup = await setupExtension();
    try {
      const ctx = makeCtx(setup.root, "empty-session");
      await setup.commands.get("agents").handler("", ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.custom).toHaveBeenCalled();
      const config = await setup.teams.readConfig("session-empty-session");
      expect(config.members.map((member: any) => member.name)).toEqual(["team-lead"]);
    } finally {
      setup.restoreEnv();
    }
  });

  it("/team opens the same empty implicit current-session panel as /agents", async () => {
    const setup = await setupExtension();
    try {
      const ctx = makeCtx(setup.root, "team-alias-session");
      expect(setup.commands.get("team")).toBe(setup.commands.get("agents"));

      await setup.commands.get("team").handler("", ctx);

      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.custom).toHaveBeenCalled();
      const config = await setup.teams.readConfig("session-team-alias-session");
      expect(config.members.map((member: any) => member.name)).toEqual(["team-lead"]);
    } finally {
      setup.restoreEnv();
    }
  });

  it("spawn_agent creates the implicit current-session group and runs edit agents in-process", async () => {
    const setup = await setupExtension();
    try {
      const ctx = makeCtx(setup.root, "edit-session");
      const abort = new AbortController().signal;

      const result = await setup.tools.get("spawn_agent")!.execute("spawn", {
        name: "editor",
        role: "write",
        prompt: "Edit the file",
        cwd: setup.root,
        model: "provider/model",
        thinking: "xhigh",
      }, abort, undefined, ctx);

      expect(result.details).toMatchObject({ name: "editor", role: "write", mode: "in-process", terminalId: null, session: "session-edit-session" });
      expect(setup.terminal.spawn).not.toHaveBeenCalled();
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledWith(
        "session-edit-session",
        expect.objectContaining({ name: "editor", role: "write", model: "provider/model", thinking: "xhigh" }),
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

  it("spawn_swarm_agents starts a batch with defaults and per-agent overrides", async () => {
    const setup = await setupExtension();
    try {
      const ctx = makeCtx(setup.root, "swarm-session");
      const abort = new AbortController().signal;

      const result = await setup.tools.get("spawn_swarm_agents")!.execute("swarm", {
        defaults: { role: "read", cwd: setup.root, model: "provider/model", thinking: "high" },
        agents: [
          { name: "one", prompt: "Inspect one" },
          { name: "two", prompt: "Inspect two", thinking: "xhigh" },
        ],
      }, abort, undefined, ctx);

      expect(result.details.spawned).toHaveLength(2);
      expect(setup.readAgentMock.runReadAgentInProcess).toHaveBeenCalledTimes(2);
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[0][1]).toMatchObject({ name: "one", thinking: "high" });
      expect(setup.readAgentMock.runReadAgentInProcess.mock.calls[1][1]).toMatchObject({ name: "two", thinking: "xhigh" });
    } finally {
      setup.restoreEnv();
    }
  });
});
