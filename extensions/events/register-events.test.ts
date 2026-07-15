import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInboxFileWatchEvent, registerExtensionEvents } from "./register-events.js";
import * as paths from "../../src/utils/paths.js";
import * as runtime from "../../src/utils/runtime.js";
import { sendPlainMessage } from "../../src/utils/messaging.js";

let root: string;
let teamsRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function setupEvents(
  isIdle: () => boolean,
  overrides: Partial<Parameters<typeof registerExtensionEvents>[1]> = {}
) {
  if (!fs.existsSync(paths.configPath("team"))) writeTeamConfig();
  const handlers = new Map<string, Function[]>();
  const quietTrigger = vi.fn();
  const terminal = { setTitle: vi.fn() };
  registerExtensionEvents({
    registerMessageRenderer: vi.fn(),
    on: vi.fn((eventName: string, handler: Function) => {
      handlers.set(eventName, [...(handlers.get(eventName) || []), handler]);
    }),
  }, {
    isTeammate: true,
    agentName: "writer",
    getTeamName: () => "team",
    setSessionCtx: vi.fn(),
    terminal,
    quietTrigger,
    startLeadInboxPolling: vi.fn(),
    startLeadWatchdog: vi.fn(),
    buildRoster: vi.fn(async () => ({ teamName: "team", members: [] })),
    formatRosterForPrompt: vi.fn(() => "Roster: empty"),
    ...overrides,
  });
  const ctx = {
    ui: { notify: vi.fn(), setTitle: vi.fn() },
    isIdle,
  };
  return { handlers, quietTrigger, terminal, ctx };
}

function writeTeamConfig(role: "read" | "write" = "write", metadata: Record<string, any> = {}) {
  const configPath = paths.configPath("team");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    name: "team",
    description: "test team",
    createdAt: Date.now(),
    leadAgentId: "lead-agent",
    leadSessionId: "session",
    members: [
      { agentId: "lead-agent", name: "team-lead", agentType: "lead", joinedAt: Date.now(), tmuxPaneId: "", cwd: root, subscriptions: [] },
      { agentId: "writer@team", name: "writer", agentType: "teammate", role, lifecycleRunId: "writer-run", joinedAt: Date.now(), tmuxPaneId: "", cwd: root, subscriptions: [], metadata },
    ],
  }, null, 2));
}

describe("extension teammate inbox wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PI_LIFECYCLE_RUN_ID", "writer-run");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-events-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("renders agent report messages open even when tool expansion is collapsed", () => {
    const registerMessageRenderer = vi.fn();
    registerExtensionEvents({
      registerMessageRenderer,
      on: vi.fn(),
    }, {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      setSessionCtx: vi.fn(),
      terminal: {},
      quietTrigger: vi.fn(),
      startLeadInboxPolling: vi.fn(),
      startLeadWatchdog: vi.fn(),
      buildRoster: vi.fn(async () => ({ teamName: "team", members: [] })),
      formatRosterForPrompt: vi.fn(() => "Roster: empty"),
    });

    const renderer = registerMessageRenderer.mock.calls.find((call) => call[0] === "pi-extended-teams-report")?.[1];
    const output = renderer({
      content: "full report body",
      details: { name: "reader", tokens: 42, elapsedMs: 1000, ok: true },
    }, { expanded: false }, {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    }).render(120).join("\n");

    expect(output).toContain("reader reported");
    expect(output).toContain("full report body");
    expect(output).not.toContain("ctrl+o");
  });

  it("injects level selection and literal-wait rules into every lead prompt", async () => {
    const handlers = new Map<string, Function[]>();
    registerExtensionEvents({
      registerMessageRenderer: vi.fn(),
      on: vi.fn((name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) || []), handler])),
    }, {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      setSessionCtx: vi.fn(),
      terminal: {},
      quietTrigger: vi.fn(),
      startLeadInboxPolling: vi.fn(),
      startLeadWatchdog: vi.fn(),
      buildRoster: vi.fn(async () => ({ teamName: "team", members: [] })),
      formatRosterForPrompt: vi.fn(() => "Roster: empty"),
    });

    const [handler] = handlers.get("before_agent_start") || [];
    const result = await handler({ systemPrompt: "base" });

    expect(result.systemPrompt).toContain("read-review is the normal default");
    expect(result.systemPrompt).toContain("Use read-collect when the lane gathers bounded facts");
    expect(result.systemPrompt).toContain("Use read-analyze when it must explain behavior or root cause");
    expect(result.systemPrompt).toContain("Reserve read-critical for irreducible high-stakes");
    expect(result.systemPrompt).toContain("write-patch for a narrow localized change");
    expect(result.systemPrompt).toContain("write-feature for a bounded feature");
    expect(result.systemPrompt).toContain("write-system for a cross-cutting integration/refactor");
    expect(result.systemPrompt).toContain("write-critical only for high-risk");
    expect(result.systemPrompt).toContain("A spawned agent owns its assigned lane");
    expect(result.systemPrompt).toContain("wait literally idle");
    expect(result.systemPrompt).toContain("Do not sleep, poll");
    expect(result.systemPrompt).toContain("Wait for the actual report before synthesizing");
    expect(result.systemPrompt).toContain("confirm it with a separate read-only agent using the intent tier that fits the confirmation");
  });

  it("wakes teammates with implicit-session inbox instructions", async () => {
    const { handlers, quietTrigger, ctx } = setupEvents(() => true);

    for (const handler of handlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    await vi.advanceTimersByTimeAsync(1000);

    expect(quietTrigger).toHaveBeenCalledWith("read_inbox to get your instructions, then begin your work.");
    expect(quietTrigger.mock.calls.flat().join("\n")).not.toContain("team_name");
  });

  it("injects teammate prompts without removed public tools or legacy parameters", async () => {
    writeTeamConfig("write", { workflowRunId: "run-1" });
    const { handlers, ctx } = setupEvents(() => true);
    for (const sessionStart of handlers.get("session_start") || []) await sessionStart({}, ctx);
    const [handler] = handlers.get("before_agent_start") || [];

    const result = await handler({ systemPrompt: "base" });
    const prompt = result.systemPrompt;

    expect(prompt).toContain("Start by calling read_inbox to get your initial instructions.");
    expect(prompt).toContain("use send_message to ask team-lead");
    expect(prompt).toContain("ask team-lead with send_message");
    expect(prompt).not.toContain("Progress reporting is required");
    expect(prompt).not.toContain("fresh progress update");
    for (const staleText of [
      "request_read_helper",
      "request_teammate",
      "broadcast_message",
      "list_teammates",
      "use_skill",
      "read_inbox(team_name",
    ]) {
      expect(prompt).not.toContain(staleText);
    }
  });

  it("remembers inbox wakeups that arrive while writer is busy and fires on turn_end", async () => {
    let idle = false;
    const { handlers, quietTrigger, ctx } = setupEvents(() => idle);

    for (const handler of handlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    quietTrigger.mockClear();

    await sendPlainMessage("team", "writer-reader", "writer", "helper report", "Read helper report");
    await vi.advanceTimersByTimeAsync(30000);
    expect(quietTrigger.mock.calls.flat()).not.toContain("You have 1 new inbox message(s). Read them with read_inbox and act.");
    quietTrigger.mockClear();

    idle = true;
    for (const handler of handlers.get("turn_end") || []) {
      await handler({}, ctx);
    }
    await vi.advanceTimersByTimeAsync(250);

    expect(quietTrigger).toHaveBeenCalledWith("You have 1 new inbox message(s). Read them with read_inbox and act.");
  });

  it("closes teammate inbox handles and prevents work after session shutdown", async () => {
    const close = vi.fn();
    let watchCallback: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const watchInboxDirectory = vi.fn((_path: string, callback: any) => {
      watchCallback = callback;
      return { close } as unknown as fs.FSWatcher;
    });
    const runtimeWrite = vi.spyOn(runtime, "writeRuntimeStatus");
    const { handlers, quietTrigger, terminal, ctx } = setupEvents(() => true, { watchInboxDirectory });

    for (const handler of handlers.get("session_start") || []) await handler({}, ctx);
    quietTrigger.mockClear();
    runtimeWrite.mockClear();
    terminal.setTitle.mockClear();
    ctx.ui.setTitle.mockClear();

    for (const handler of handlers.get("session_shutdown") || []) await handler({}, ctx);
    expect(close).toHaveBeenCalledTimes(1);

    watchCallback?.("change", "writer.json");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtimeWrite).not.toHaveBeenCalled();
    expect(quietTrigger).not.toHaveBeenCalled();
    expect(terminal.setTitle).not.toHaveBeenCalled();
    expect(ctx.ui.setTitle).not.toHaveBeenCalled();
  });

  it("treats inbox lock-file writes as wake-worthy fs.watch events", () => {
    const inboxFile = path.join(root, "teams", "team", "inboxes", "writer.json");

    expect(isInboxFileWatchEvent(inboxFile, "writer.json.lock")).toBe(true);
    expect(isInboxFileWatchEvent(inboxFile, "writer.json")).toBe(true);
    expect(isInboxFileWatchEvent(inboxFile, undefined)).toBe(true);
    expect(isInboxFileWatchEvent(inboxFile, "team-lead.json.lock")).toBe(false);
  });

  it("records writer current action in runtime status for /team", async () => {
    const { handlers, ctx } = setupEvents(() => true);

    for (const handler of handlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    await runtime.writeRuntimeStatus("team", "writer", "writer-run", {
      latestProgress: "Reviewing event lifecycle",
      progressUpdatedAt: 1234,
    });
    for (const handler of handlers.get("turn_start") || []) {
      await handler({}, ctx);
    }
    expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({
      currentAction: "thinking",
      latestProgress: "Reviewing event lifecycle",
      progressUpdatedAt: 1234,
    });

    for (const handler of handlers.get("tool_execution_start") || []) {
      await handler({ toolName: "bash" }, ctx);
    }
    expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({
      currentAction: "working",
      activeToolName: "bash",
      latestProgress: "Reviewing event lifecycle",
    });

    for (const handler of handlers.get("tool_execution_end") || []) {
      await handler({}, ctx);
    }
    const afterTool = await runtime.readRuntimeStatus("team", "writer");
    expect(afterTool).toMatchObject({
      currentAction: "thinking",
      latestProgress: "Reviewing event lifecycle",
      progressUpdatedAt: 1234,
    });
    expect(afterTool).not.toHaveProperty("activeToolName");
  });

  it("records writer token usage in runtime status for /team", async () => {
    const { handlers, ctx } = setupEvents(() => true);
    const assistantMessage = {
      role: "assistant",
      provider: "provider",
      model: "model",
      timestamp: 123,
      stopReason: "toolUse",
      content: [],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 5,
        cost: { total: 0.123 },
      },
    };
    (ctx as any).sessionManager = { getBranch: vi.fn(() => []) };

    for (const handler of handlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    for (const handler of handlers.get("message_end") || []) {
      await handler({ message: assistantMessage }, ctx);
    }

    expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({ tokensUsed: 175 });
  });

  it("defers the turn_end inbox wake until the writer session becomes idle", async () => {
    let idle = false;
    const { handlers, quietTrigger, ctx } = setupEvents(() => idle);

    for (const handler of handlers.get("session_start") || []) {
      await handler({}, ctx);
    }
    quietTrigger.mockClear();

    await sendPlainMessage("team", "writer-reader", "writer", "helper report", "Read helper report");
    await vi.advanceTimersByTimeAsync(30000);
    expect(quietTrigger.mock.calls.flat()).not.toContain("You have 1 new inbox message(s). Read them with read_inbox and act.");

    for (const handler of handlers.get("turn_end") || []) {
      await handler({}, ctx);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(quietTrigger.mock.calls.flat()).not.toContain("You have 1 new inbox message(s). Read them with read_inbox and act.");

    idle = true;
    await vi.advanceTimersByTimeAsync(250);

    expect(quietTrigger).toHaveBeenCalledWith("You have 1 new inbox message(s). Read them with read_inbox and act.");
  });
});
