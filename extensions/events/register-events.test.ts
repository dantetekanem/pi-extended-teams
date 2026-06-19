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
}

function setupEvents(isIdle: () => boolean) {
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
  });
  const ctx = {
    ui: { notify: vi.fn(), setTitle: vi.fn() },
    isIdle,
  };
  return { handlers, quietTrigger, terminal, ctx };
}

describe("extension teammate inbox wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-events-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
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
    for (const handler of handlers.get("turn_start") || []) {
      await handler({}, ctx);
    }
    expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({ currentAction: "thinking" });

    for (const handler of handlers.get("tool_execution_start") || []) {
      await handler({ toolName: "bash" }, ctx);
    }
    expect(await runtime.readRuntimeStatus("team", "writer")).toMatchObject({ currentAction: "working", activeToolName: "bash" });

    for (const handler of handlers.get("tool_execution_end") || []) {
      await handler({}, ctx);
    }
    const afterTool = await runtime.readRuntimeStatus("team", "writer");
    expect(afterTool).toMatchObject({ currentAction: "thinking" });
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
