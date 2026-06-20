import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCoordinationTools } from "./coordination-tools.js";
import * as paths from "../../src/utils/paths.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as reportEvents from "../../src/utils/report-events.js";
import type { Member, TeamConfig } from "../../src/utils/models.js";

let root: string;
let teamsRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: string, agentName: string) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function member(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@exit`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    role: name === "team-lead" ? undefined : "write",
    joinedAt: Date.now(),
    tmuxPaneId: name === "team-lead" ? "" : `%${name}`,
    cwd: root,
    subscriptions: [],
    ...overrides,
  };
}

function writeConfig(config: TeamConfig) {
  fs.mkdirSync(path.dirname(paths.configPath(config.name)), { recursive: true });
  fs.writeFileSync(paths.configPath(config.name), JSON.stringify(config, null, 2));
}

describe("coordination tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-coordination-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("report_and_exit unlinks the exiting writer pid file before shutdown", async () => {
    vi.useFakeTimers();
    const teamName = "exit-team";
    const agentName = "writer";
    writeConfig({
      name: teamName,
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member(agentName, { tmuxPaneId: "%writer", model: "provider/model", thinking: "high" }),
      ],
    });
    const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
    fs.writeFileSync(pidFile, String(process.pid));
    await runtime.writeRuntimeStatus(teamName, agentName, {
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      ready: true,
    });

    const sendSpy = vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);
    vi.spyOn(reportEvents, "appendTeamReportEvent").mockResolvedValue({} as any);
    const releaseAllClaimsForAgent = vi.fn(async () => [] as string[]);
    const drainWriteQueue = vi.fn(async () => {});
    const terminal = { kill: vi.fn() };
    const ctx = { cwd: root, shutdown: vi.fn() };
    const tools = new Map<string, any>();

    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName,
      isTeammate: true,
      terminal,
      getTeamName: () => teamName,
      requireWriteAgentTeam: async () => teamName,
      requireTeamContext: (explicitTeamName?: string) => explicitTeamName || teamName,
      releaseAllClaimsForAgent,
      drainWriteQueue,
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    const result = await tools.get("report_and_exit").execute(
      "report",
      { content: "done", summary: "Done" },
      new AbortController().signal,
      vi.fn(),
      ctx
    );

    expect(sendSpy).toHaveBeenCalledWith(
      teamName,
      agentName,
      "team-lead",
      "done",
      "Done",
      undefined,
      expect.any(Object)
    );
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(await runtime.readRuntimeStatus(teamName, agentName)).toBeNull();
    expect(releaseAllClaimsForAgent).toHaveBeenCalledWith(teamName, agentName);
    expect(drainWriteQueue).toHaveBeenCalledWith(teamName);
    expect(JSON.parse(fs.readFileSync(paths.configPath(teamName), "utf-8")).members.map((item: Member) => item.name)).toEqual(["team-lead"]);
    expect(result.content[0].text).toContain("Final report sent.");

    await vi.runOnlyPendingTimersAsync();
    expect(terminal.kill).toHaveBeenCalledWith("%writer");
    expect(ctx.shutdown).toHaveBeenCalled();
  });
});
