import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { buildTeamPanelItems, MAX_COMPLETED_REPORTS, registerTeamCommand } from "./team-panel.js";
import { teamActivityStatusWidget, type TeamActivityStatusSnapshot } from "./status-widget.js";
import * as paths from "../../src/utils/paths.js";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import { sendPlainMessage } from "../../src/utils/messaging.js";
import type { RunningReadAgent } from "../runtime/types.js";

let root: string;
let teamsRoot: string;
let tasksRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(tasksRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "claims.json"));
}

function panelOptions(overrides: any = {}) {
  return {
    getTeamName: () => "team",
    getLeadInboxUnreadCount: () => 0,
    runningReadAgents: new Map(),
    completedAgentReports: new Map(),
    readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    terminal: { isAlive: vi.fn(() => true), focusPane: vi.fn(() => true) },
    shutdownTeammate: vi.fn(),
    ...overrides,
  };
}

function readerName(index: number): string {
  return `reader-${String(index).padStart(3, "0")}`;
}

function makeRunningReadAgent(name: string, startedAt: number): RunningReadAgent {
  return {
    runId: `run-${name}`,
    name,
    teamName: "team",
    startedAt,
    tokensUsed: 12,
    status: "thinking",
    recentEvents: ["thinking"],
    lastActivityAt: startedAt,
    model: "provider/model",
    thinking: "high",
  };
}

function makeActivitySnapshot(count: number): TeamActivityStatusSnapshot {
  return {
    activeCount: count,
    readCount: count,
    writeCount: 0,
    unreadCount: 0,
    updatedAt: Date.now(),
    statusCounts: { thinking: count },
    entries: Array.from({ length: count }, (_value, index) => ({
      name: readerName(index),
      role: "read",
      status: "thinking",
      detail: "provider/model · 12 tok · waiting for model response",
    })),
  };
}

describe("team panel items", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-team-panel-"));
    teamsRoot = path.join(root, "teams");
    tasksRoot = path.join(root, "tasks");
    fs.mkdirSync(teamsRoot, { recursive: true });
    fs.mkdirSync(tasksRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the team activity widget compact for 300 active agents", () => {
    const snapshot = makeActivitySnapshot(300);
    const collapsed = teamActivityStatusWidget(() => snapshot, () => false).render(80);
    const collapsedText = collapsed.join("\n");

    expect(collapsed).toHaveLength(4);
    expect(collapsedText).toContain("300 active");
    expect(collapsedText).toContain("summary");
    expect(collapsedText).toContain("300 thinking");
    expect(collapsedText).not.toContain("reader-000");
    expect(collapsed.every((line) => visibleWidth(line) <= 80)).toBe(true);

    const expanded = teamActivityStatusWidget(() => snapshot, () => true).render(80);
    const expandedText = expanded.join("\n");

    expect(expanded).toHaveLength(15);
    expect(expandedText).toContain("300 thinking");
    expect(expandedText).toContain("reader-000");
    expect(expandedText).toContain("reader-009");
    expect(expandedText).not.toContain("reader-010");
    expect(expandedText).toContain("290 more active agents");
    expect(expanded.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("renders the /team overlay compactly for 300 active read agents", async () => {
    const now = Date.now();
    const config = teams.createTeam("team", "session", "lead", "", "provider/model");
    const runningReadAgents = new Map<string, RunningReadAgent>();

    for (let index = 0; index < 300; index++) {
      const name = readerName(index);
      config.members.push({
        agentId: `${name}@team`,
        name,
        agentType: "teammate",
        role: "read",
        model: "provider/model",
        thinking: "high",
        joinedAt: now - index,
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
      });
      runningReadAgents.set(`team:${name}`, makeRunningReadAgent(name, now - index));
    }
    fs.writeFileSync(paths.configPath("team"), JSON.stringify(config, null, 2));

    let component: any;
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, panelOptions({ runningReadAgents }));

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, { fg: (_name: string, text: string) => text }, {}, vi.fn());
        }),
      },
    });

    const rendered = component.render(120);
    const output = rendered.join("\n");

    expect(rendered.length).toBeLessThan(40);
    expect(rendered.every((line: string) => visibleWidth(line) <= 120)).toBe(true);
    expect(output).toContain("read agents");
    expect(output).toContain("300 (in-process)");
    expect(output).not.toContain("reader-299");

    component.dispose();
  });

  it("keeps the write agent tmux pane id for status/detail rendering", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%42",
      cwd: root,
      subscriptions: [],
    });

    const items = await buildTeamPanelItems("team", panelOptions());

    expect(items.find(item => item.name === "writer")).toMatchObject({
      role: "write",
      status: "running",
      tmuxPaneId: "%42",
    });
  });

  it("focuses the selected agent log from /agents without attaching tmux panes", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%42",
      windowId: "@9",
      cwd: root,
      subscriptions: [],
    });

    let component: any;
    const done = vi.fn();
    const terminal = { isAlive: vi.fn(() => true), focusPane: vi.fn(() => true) };
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, panelOptions({ terminal }));

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, { fg: (_name: string, text: string) => text }, {}, done);
        }),
      },
    });

    component.handleInput("j");
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Legacy tmux-backed agent @9/%42 has no in-process transcript.");
    expect(rendered).toContain("enter/a: focus log");

    component.handleInput("\r");
    expect(terminal.focusPane).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    component.dispose();
  });

  it("infers completed read-agent role from read helper lead inbox summaries", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await sendPlainMessage("team", "writer-reader", "team-lead", "Read helper writer-reader completed for writer. Report sent to writer.", "Read helper writer-reader done", "cyan");

    const items = await buildTeamPanelItems("team", panelOptions());

    expect(items.find(item => item.name === "writer-reader")).toMatchObject({
      role: "read",
      completed: true,
      summary: "Read helper writer-reader done",
      requestedBy: "writer",
    });
  });

  it("does not treat active-agent progress messages as completed reports", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%42",
      cwd: root,
      subscriptions: [],
    });
    await sendPlainMessage("team", "writer", "team-lead", "Still investigating the issue.", "Progress update", "yellow");

    const items = await buildTeamPanelItems("team", panelOptions());
    const writerItems = items.filter(item => item.name === "writer");

    expect(writerItems).toHaveLength(1);
    expect(writerItems[0]).toMatchObject({ completed: false, status: "running" });
  });

  it("keeps active reader and writer metadata visible in /agents item data", async () => {
    const now = Date.now();
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/writer-model",
      thinking: "xhigh",
      joinedAt: now - 12_000,
      tmuxPaneId: "%42",
      cwd: root,
      subscriptions: [],
    });
    await teams.addMember("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/reader-model",
      thinking: "high",
      joinedAt: now - 5_000,
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      requestedBy: "writer",
      helperKind: "read_helper",
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    runningReadAgents.set("team:writer-reader", {
      runId: "run-1",
      name: "writer-reader",
      teamName: "team",
      startedAt: now - 5_000,
      tokensUsed: 1234,
      status: "working",
      recentEvents: ["working: bash"],
      lastActivityAt: now,
      model: "provider/reader-model",
      thinking: "high",
    });

    await runtime.writeRuntimeStatus("team", "writer", {
      startedAt: now - 12_000,
      ready: true,
      currentAction: "working",
      activeToolName: "bash",
      tokensUsed: 77,
    });

    const items = await buildTeamPanelItems("team", panelOptions({ runningReadAgents }));

    expect(items.find(item => item.name === "writer")).toMatchObject({
      role: "write",
      status: "working",
      model: "provider/writer-model",
      thinking: "xhigh",
      tmuxPaneId: "%42",
      tokensUsed: 77,
      completed: false,
    });
    expect(items.find(item => item.name === "writer")!.elapsedMs).toBeGreaterThanOrEqual(10_000);
    expect(items.find(item => item.name === "writer")!.runtimeStatus?.activeToolName).toBe("bash");
    expect(items.find(item => item.name === "writer-reader")).toMatchObject({
      role: "read",
      status: "working",
      model: "provider/reader-model",
      thinking: "high",
      tokensUsed: 1234,
      requestedBy: "writer",
      completed: false,
    });
  });

  it("/agents without an active session shows a safe message", async () => {
    const pi = { registerCommand: vi.fn() } as any;
    const options = panelOptions({ getTeamName: () => undefined });
    registerTeamCommand(pi, options);
    const command = pi.registerCommand.mock.calls.find((call: any[]) => call[0] === "agents")?.[1];
    const ctx = { ui: { notify: vi.fn(), custom: vi.fn() } };

    await command.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No active agent session. Spawn an agent first.", "warning");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("keeps completed writer history even when a writer with the same name is active again", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%42",
      cwd: root,
      subscriptions: [],
    });
    await sendPlainMessage("team", "writer", "team-lead", "previous writer report", "Previous writer done", "green", {
      metadata: { tokensUsed: 321, elapsedMs: 4567, model: "provider/model", thinking: "xhigh" },
    });

    const items = await buildTeamPanelItems("team", panelOptions());
    const writerItems = items.filter(item => item.name === "writer");
    const completedWriter = writerItems.find(item => item.completed && item.reportText === "previous writer report");

    expect(writerItems).toHaveLength(2);
    expect(writerItems.some(item => !item.completed && item.status === "running")).toBe(true);
    expect(completedWriter).toMatchObject({ tokensUsed: 321, elapsedMs: 4567, model: "provider/model", thinking: "xhigh" });
  });

  it("sanitizes unsafe transcript control sequences before overlay rendering", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const runningReadAgents = new Map<string, RunningReadAgent>();
    await teams.addMember("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    });
    runningReadAgents.set("team:reader", {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      model: "provider/model",
      thinking: "high",
      session: {
        messages: [
          { role: "user", content: [{ type: "text", text: "first\rOVERWRITE\nnext\x1b[2Jclear" }] },
          { role: "assistant", content: [{ type: "text", text: "reply\x1b[999Dcursor\bbackspace" }] },
          { role: "toolResult", toolName: "bash\x1b[K", content: [{ type: "text", text: "line\ragain" }] },
        ],
      } as any,
    });

    let component: any;
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, panelOptions({ runningReadAgents }));

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, { fg: (_name: string, text: string) => text }, {}, vi.fn());
        }),
      },
    });

    component.handleInput("j");
    const rendered = component.render(120);
    const output = rendered.join("\n");

    expect(output).toContain("OVERWRITE");
    expect(output).toContain("cursorbackspace");
    expect(output).not.toContain("\r");
    expect(output).not.toContain("\b");
    expect(output).not.toContain("\x1b[2J");
    expect(output).not.toContain("\x1b[999D");
    expect(output).not.toContain("\x1b[K");
    expect(rendered.every((line: string) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("caps completed history to the most recent reports", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    vi.useFakeTimers();
    try {
      const base = new Date("2026-06-19T00:00:00.000Z").getTime();
      for (let index = 0; index < MAX_COMPLETED_REPORTS + 5; index++) {
        vi.setSystemTime(new Date(base + index * 1000));
        await sendPlainMessage("team", `writer-${index.toString().padStart(2, "0")}`, "team-lead", `report ${index}`, "Final report", "green");
      }

      const items = await buildTeamPanelItems("team", panelOptions());
      const completed = items.filter(item => item.completed);

      expect(completed).toHaveLength(MAX_COMPLETED_REPORTS);
      expect(completed[0]).toMatchObject({ name: `writer-${(MAX_COMPLETED_REPORTS + 4).toString().padStart(2, "0")}`, reportText: `report ${MAX_COMPLETED_REPORTS + 4}` });
      expect(completed.some(item => item.name === "writer-00")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("windows the left teammate list around the selected agent", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    for (let index = 0; index < 120; index++) {
      const name = `agent-${index.toString().padStart(3, "0")}`;
      await teams.addMember("team", {
        agentId: `${name}@team`,
        name,
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        joinedAt: Date.now(),
        tmuxPaneId: `%${index}`,
        cwd: root,
        subscriptions: [],
      });
    }

    let component: any;
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, panelOptions());

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory({ requestRender: vi.fn(), terminal: { rows: 18 } }, { fg: (_name: string, text: string) => text }, {}, vi.fn());
        }),
      },
    });

    for (let index = 0; index <= 60; index++) component.handleInput("j");
    const output = component.render(120).join("\n");

    expect(output).toContain("agent-060");
    expect(output).toContain("more above");
    expect(output).toContain("more below");
    expect(output).not.toContain("agent-000");
    expect(output).not.toContain("agent-119");

    component.dispose();
  });

  it("limits live read-agent transcript formatting to recent messages", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const runningReadAgents = new Map<string, RunningReadAgent>();
    await teams.addMember("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    });
    runningReadAgents.set("team:reader", {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      model: "provider/model",
      thinking: "high",
      session: {
        messages: Array.from({ length: 25 }, (_value, index) => ({
          role: "user",
          content: [{ type: "text", text: `message ${index}` }],
        })),
      } as any,
    });

    let component: any;
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, panelOptions({ runningReadAgents }));

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory({ requestRender: vi.fn(), terminal: { rows: 80 } }, { fg: (_name: string, text: string) => text }, {}, vi.fn());
        }),
      },
    });

    component.handleInput("j");
    const output = component.render(120).join("\n");

    expect(output).toContain("showing last 20 of 25 transcript messages");
    expect(output).toContain("message 24");
    expect(output).not.toContain("message 0");

    component.dispose();
  });

  it("stops auto-refreshing when only completed reports remain", async () => {
    vi.useFakeTimers();
    try {
      teams.createTeam("team", "session", "lead", "", "provider/model");
      await sendPlainMessage("team", "writer", "team-lead", "final writer report", "Final report", "green");

      let component: any;
      const tui = { requestRender: vi.fn(), terminal: { rows: 30 } };
      const theme = {
        fg: (_name: string, text: string) => text,
        bold: (text: string) => text,
      };
      const pi = {
        registerCommand: vi.fn((_name: string, command: any) => {
          pi.command = command;
        }),
        command: undefined as any,
      };
      registerTeamCommand(pi, panelOptions());

      await pi.command.handler("team", {
        ui: {
          notify: vi.fn(),
          custom: vi.fn(async (factory: any) => {
            component = factory(tui, theme, {}, vi.fn());
          }),
        },
      });

      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("completed");
      expect(rendered).toContain("1");

      await vi.advanceTimersByTimeAsync(3000);

      expect(tui.requestRender).not.toHaveBeenCalled();
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-refreshes an open team overlay when new read agents appear", async () => {
    vi.useFakeTimers();
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = panelOptions({ runningReadAgents });
    let component: any;
    const tui = { requestRender: vi.fn(), terminal: { rows: 30 } };
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const pi = {
      registerCommand: vi.fn((_name: string, command: any) => {
        pi.command = command;
      }),
      command: undefined as any,
    };
    registerTeamCommand(pi, options);

    await pi.command.handler("team", {
      ui: {
        notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          component = factory(tui, theme, {}, vi.fn());
        }),
      },
    });

    let rendered = component.render(120).join("\n");
    expect(rendered).toContain("read agents");
    expect(rendered).toContain("0 (in-process)");

    await teams.addMember("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      requestedBy: "writer",
      helperKind: "read_helper",
    });
    runningReadAgents.set("team:writer-reader", {
      runId: "run-1",
      name: "writer-reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: ["working: read"],
      lastActivityAt: Date.now(),
      model: "provider/model",
      thinking: "high",
    });

    await vi.advanceTimersByTimeAsync(1000);
    rendered = component.render(120).join("\n");

    expect(rendered).toContain("read agents");
    expect(rendered).toContain("1 (in-process)");
    expect(rendered).toContain("writer-reader");
    expect(rendered).toContain("read");

    component.handleInput("j");
    rendered = component.render(120).join("\n");
    expect(rendered).toContain("requested by");
    expect(rendered).toContain("writer");

    component.dispose();
    vi.useRealTimers();
  });
});
