import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupOrphanedTeams, cleanupPidFileProcess, cleanupStaleTeam, findLeadTeamForSession, forceCleanupTeam, registerLeadSession } from "./session-files.js";
import * as paths from "../../src/utils/paths.js";

let root: string;
let teamsRoot: string;
let tasksRoot: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: string) => path.join(tasksRoot, paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "leadSessionPath").mockImplementation((teamName: string) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "lead-session.json"));
}

function writeTeam(teamName: string, options: { leadPid?: number; sessionId?: string; createdAt?: number; paneId?: string } = {}) {
  const teamDir = paths.teamDir(teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(paths.taskDir(teamName), { recursive: true });
  fs.writeFileSync(paths.configPath(teamName), JSON.stringify({
    name: teamName,
    createdAt: options.createdAt ?? Date.now(),
    members: [
      { name: "team-lead", agentType: "lead" },
      { name: "writer", agentType: "teammate", role: "write", tmuxPaneId: options.paneId ?? "%7" },
    ],
  }, null, 2));
  if (options.leadPid !== undefined) {
    fs.writeFileSync(paths.leadSessionPath(teamName), JSON.stringify({
      pid: options.leadPid,
      sessionId: options.sessionId,
      startedAt: options.createdAt ?? Date.now(),
    }));
  }
  fs.writeFileSync(path.join(teamDir, "writer.pid"), "99999999");
}

describe("session file cleanup", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-session-files-"));
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

  it("force-cleans a team directory, task directory, pid file, and terminal pane", () => {
    const terminal = { kill: vi.fn() };
    writeTeam("dead-team", { leadPid: 99999999, paneId: "%9" });

    expect(forceCleanupTeam("dead-team", terminal)).toBe(true);

    expect(fs.existsSync(paths.teamDir("dead-team"))).toBe(false);
    expect(fs.existsSync(paths.taskDir("dead-team"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("%9");
  });

  it("unlinks stale pid files even when process kill fails", () => {
    const killError = Object.assign(new Error("process is gone"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw killError;
    }) as typeof process.kill);
    const pidFile = path.join(paths.teamDir("pid-team"), "writer.pid");
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "99999999");

    const result = cleanupPidFileProcess(pidFile);

    expect(result).toMatchObject({ pid: 99999999, killed: false, unlinked: true, killError });
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(99999999, "SIGKILL");
  });

  it("cleanupStaleTeam removes teams whose recorded lead pid is gone", () => {
    const terminal = { kill: vi.fn() };
    writeTeam("stale-team", { leadPid: 99999999 });

    expect(cleanupStaleTeam("stale-team", terminal)).toBe(true);

    expect(fs.existsSync(paths.teamDir("stale-team"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("%7");
  });

  it("cleanupStaleTeam leaves teams whose lead pid is still alive", () => {
    const terminal = { kill: vi.fn() };
    writeTeam("live-team", { leadPid: process.pid });

    expect(cleanupStaleTeam("live-team", terminal)).toBe(false);

    expect(fs.existsSync(paths.teamDir("live-team"))).toBe(true);
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it("findLeadTeamForSession only matches the current Pi session id, not just pid", () => {
    writeTeam("other-session", { leadPid: process.pid, sessionId: "other-session-id" });
    writeTeam("current-session", { leadPid: process.pid, sessionId: "current-session-id" });

    expect(findLeadTeamForSession()).toBeNull();
    expect(findLeadTeamForSession("other-session-id")).toBe("other-session");
    expect(findLeadTeamForSession("current-session-id")).toBe("current-session");
    expect(findLeadTeamForSession("missing-session-id")).toBeNull();
  });

  it("findLeadTeamForSession ignores stray entries that are not valid team names", () => {
    writeTeam("current-session", { leadPid: process.pid, sessionId: "current-session-id" });
    fs.writeFileSync(path.join(teamsRoot, ".DS_Store"), "stray");

    expect(findLeadTeamForSession("current-session-id")).toBe("current-session");
  });

  it("findLeadTeamForSession does not attach a matching session owned by another process", () => {
    writeTeam("same-session-other-pid", { leadPid: 99999999, sessionId: "current-session-id" });

    expect(findLeadTeamForSession("current-session-id")).toBeNull();
  });

  it("registerLeadSession records the Pi session id used for future adoption", () => {
    writeTeam("session-bound");

    registerLeadSession("session-bound", "session-id-1");

    const record = JSON.parse(fs.readFileSync(paths.leadSessionPath("session-bound"), "utf-8"));
    expect(record).toMatchObject({ pid: process.pid, sessionId: "session-id-1" });
  });

  it("cleanupOrphanedTeams removes old teams with no live lead session and skips fresh ones", () => {
    const terminal = { kill: vi.fn() };
    const now = Date.now();
    writeTeam("old-orphan", { createdAt: now - 2 * 60 * 60 * 1000 });
    writeTeam("fresh-orphan", { createdAt: now });

    const cleaned = cleanupOrphanedTeams(terminal, {
      teamsRoot,
      now,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(cleaned).toBe(1);
    expect(fs.existsSync(paths.teamDir("old-orphan"))).toBe(false);
    expect(fs.existsSync(paths.teamDir("fresh-orphan"))).toBe(true);
    expect(terminal.kill).toHaveBeenCalledWith("%7");
  });

  it("retains a dead-lead team until its private recovery transcript ages out", () => {
    const terminal = { kill: vi.fn() };
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000;
    writeTeam("recoverable-team", { leadPid: 99999999, createdAt: now - 2 * maxAgeMs });
    const runDirectory = path.join(paths.teamDir("recoverable-team"), "agent-sessions", "reader", "failed-run");
    const transcript = path.join(runDirectory, "session.jsonl");
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(transcript, "recoverable transcript\n");
    const recent = new Date(now - 1_000);
    const stale = new Date(now - maxAgeMs - 1_000);
    // Retention follows the newest transcript activity, not directory creation.
    fs.utimesSync(runDirectory, stale, stale);
    fs.utimesSync(transcript, recent, recent);

    expect(cleanupOrphanedTeams(terminal, { teamsRoot, now, maxAgeMs })).toBe(0);
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(paths.teamDir("recoverable-team"))).toBe(true);
    expect(terminal.kill).toHaveBeenCalledWith("%7");
    terminal.kill.mockClear();

    fs.utimesSync(transcript, stale, stale);

    expect(cleanupOrphanedTeams(terminal, { teamsRoot, now, maxAgeMs })).toBe(1);
    expect(fs.existsSync(paths.teamDir("recoverable-team"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("%7");
  });

  it("retains an orphan when recovery enumeration fails and continues cleaning later teams", () => {
    const terminal = { kill: vi.fn() };
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000;
    writeTeam("a-unreadable-recovery", { leadPid: 99999999, createdAt: now - 2 * maxAgeMs });
    writeTeam("b-old-orphan", { createdAt: now - 2 * maxAgeMs });
    const recoveryAgentDirectory = path.join(paths.teamDir("a-unreadable-recovery"), "agent-sessions", "reader");
    const recoveryRunDirectory = path.join(recoveryAgentDirectory, "failed-run");
    fs.mkdirSync(recoveryRunDirectory, { recursive: true });
    fs.writeFileSync(path.join(recoveryRunDirectory, "session.jsonl"), "recoverable transcript\n");
    const originalReadDirectory = fs.readdirSync.bind(fs);
    const readDirectory = vi.spyOn(fs, "readdirSync").mockImplementation(((directory: any, options?: any) => {
      if (directory === recoveryAgentDirectory) throw new Error("simulated transient enumeration failure");
      return originalReadDirectory(directory, options);
    }) as typeof fs.readdirSync);

    const cleaned = cleanupOrphanedTeams(terminal, { teamsRoot, now, maxAgeMs });

    expect(cleaned).toBe(1);
    expect(fs.existsSync(paths.teamDir("a-unreadable-recovery"))).toBe(true);
    expect(fs.existsSync(path.join(recoveryRunDirectory, "session.jsonl"))).toBe(true);
    expect(fs.existsSync(paths.teamDir("b-old-orphan"))).toBe(false);
    expect(readDirectory).toHaveBeenCalledWith(recoveryAgentDirectory, { withFileTypes: true });
  });

  it("stops orphan processes but never TTL-cleans a fenced dead-lead team", () => {
    const terminal = { kill: vi.fn() };
    const now = Date.now();
    writeTeam("quarantined-orphan", { leadPid: 99999999, createdAt: now - 2 * 60 * 60 * 1000 });
    const quarantineDir = path.join(paths.teamDir("quarantined-orphan"), "lifecycle", "quarantine");
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.writeFileSync(path.join(quarantineDir, "writer.json"), "{ malformed");

    const cleaned = cleanupOrphanedTeams(terminal, {
      teamsRoot,
      now,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(cleaned).toBe(0);
    expect(fs.existsSync(paths.teamDir("quarantined-orphan"))).toBe(true);
    expect(fs.existsSync(path.join(paths.teamDir("quarantined-orphan"), "writer.pid"))).toBe(false);
    expect(terminal.kill).toHaveBeenCalledWith("%7");
  });
});
