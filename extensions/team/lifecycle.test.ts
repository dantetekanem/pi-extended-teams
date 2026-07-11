import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLifecycleRuntime } from "./lifecycle.js";
import * as paths from "../../src/utils/paths.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as teams from "../../src/utils/teams.js";
import type { Member, TeamConfig } from "../../src/utils/models.js";

let root: string;
let teamsRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(teamsRoot, paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function member(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@scale`,
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

describe("team lifecycle performance", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-lifecycle-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("stops and restarts the lead watchdog without leaking intervals", async () => {
    vi.useFakeTimers();
    try {
      const getTeamName = vi.fn(() => null);
      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents: new Map(),
        readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: () => true,
        renderReadAgentStatus: vi.fn(),
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName,
      });

      lifecycle.startLeadWatchdog();
      lifecycle.startLeadWatchdog();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getTeamName).toHaveBeenCalledTimes(1);

      lifecycle.stopLeadWatchdog();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getTeamName).toHaveBeenCalledTimes(1);

      lifecycle.startLeadWatchdog();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getTeamName).toHaveBeenCalledTimes(2);
      lifecycle.stopLeadWatchdog();
    } finally {
      vi.useRealTimers();
    }
  });

  it("batch-removes watchdog-reaped teammates and drains the write queue once", async () => {
    const config: TeamConfig = {
      name: "scale",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member("gone-1", { tmuxPaneId: "%gone-1" }),
        member("gone-2", { tmuxPaneId: "%gone-2" }),
        member("alive", { tmuxPaneId: "%alive" }),
      ],
    };
    writeConfig(config);

    const terminal = {
      isAlive: vi.fn((paneId: string) => paneId === "%alive"),
      kill: vi.fn(),
    };
    const drainWriteQueue = vi.fn(async () => {});
    const removeMemberSpy = vi.spyOn(teams, "removeMember");
    vi.spyOn(runtime, "readRuntimeStatus").mockImplementation(async (teamName: string, agentName: string) => ({
      teamName,
      agentName,
      ready: true,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    }));
    vi.spyOn(runtime, "deleteRuntimeStatus").mockResolvedValue(false);
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);

    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal,
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      drainWriteQueue,
      getSessionCwd: () => root,
      getTeamName: () => "scale",
    });

    await lifecycle.runWatchdogOnce("scale");

    const updated = JSON.parse(fs.readFileSync(paths.configPath("scale"), "utf-8")) as TeamConfig;
    expect(updated.members.map((item) => item.name)).toEqual(["team-lead", "alive"]);
    expect(removeMemberSpy).not.toHaveBeenCalled();
    expect(drainWriteQueue).toHaveBeenCalledTimes(1);
    expect(terminal.kill).toHaveBeenCalledTimes(2);
    expect(messaging.sendPlainMessage).toHaveBeenCalledTimes(2);
  });

  it("unlinks writer pid files when watchdog kill finds a dead process", async () => {
    const config: TeamConfig = {
      name: "stale-pid",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members: [
        member("team-lead"),
        member("gone", { tmuxPaneId: "%gone" }),
      ],
    };
    writeConfig(config);
    const pidFile = path.join(paths.teamDir("stale-pid"), "gone.pid");
    fs.writeFileSync(pidFile, "99999999");

    const killError = Object.assign(new Error("process is gone"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw killError;
    }) as typeof process.kill);
    const terminal = {
      isAlive: vi.fn(() => false),
      kill: vi.fn(),
    };
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "stale-pid",
      agentName: "gone",
      ready: true,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    });
    vi.spyOn(runtime, "deleteRuntimeStatus").mockResolvedValue(false);
    vi.spyOn(runtime, "cleanupStaleRuntimeFiles").mockResolvedValue(0);
    vi.spyOn(messaging, "sendPlainMessage").mockResolvedValue(undefined as any);

    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal,
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      renderReadAgentStatus: vi.fn(),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "stale-pid",
    });

    await lifecycle.runWatchdogOnce("stale-pid");

    expect(fs.existsSync(pidFile)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(99999999, "SIGKILL");
    expect(terminal.kill).toHaveBeenCalledWith("%gone");
  });
});
