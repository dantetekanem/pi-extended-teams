import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import {
  PRIVATE_AGENT_SESSION_RETENTION_MS,
  cleanupPrivateAgentSessionDirectory,
  cleanupStalePrivateAgentSessions,
  preparePrivateAgentSessionDirectory,
} from "./agent-session-files.js";

let root: string;
let teamsRoot: string;

function privateRunDirectory(teamName: string, agentName: string, runId: string): string {
  return path.join(teamsRoot, teamName, "agent-sessions", agentName, runId);
}

function writeTeamConfig(
  teamName: string,
  members: Array<{ name: string; lifecycleRunId?: string; isActive?: boolean }> = [],
): void {
  const teamDirectory = path.join(teamsRoot, teamName);
  fs.mkdirSync(teamDirectory, { recursive: true });
  fs.writeFileSync(path.join(teamDirectory, "config.json"), JSON.stringify({
    name: teamName,
    members: [
      { name: "team-lead", agentType: "lead" },
      ...members.map(member => ({ ...member, agentType: "teammate" })),
    ],
  }));
}

function createRunDirectory(teamName: string, agentName: string, runId: string): string {
  const directory = privateRunDirectory(teamName, agentName, runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "session.jsonl"), "private transcript\n");
  return directory;
}

describe("private spawned-agent session files", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-private-agent-sessions-"));
    teamsRoot = path.join(root, "teams");
    fs.mkdirSync(teamsRoot, { recursive: true });
    vi.spyOn(paths, "teamDir").mockImplementation(teamName => {
      return path.join(teamsRoot, paths.sanitizeName(String(teamName)));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a private per-run directory outside Pi's resumable session tree", () => {
    writeTeamConfig("team");

    const directory = preparePrivateAgentSessionDirectory("team", "reader", "run-one");

    expect(directory).toBe(privateRunDirectory("team", "reader", "run-one"));
    expect(directory).not.toContain(path.join(".pi", "agent", "sessions"));
    expect(fs.statSync(directory).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("removes only the exact completed run and preserves sibling and unrelated files", () => {
    writeTeamConfig("team");
    const completed = createRunDirectory("team", "reader", "run-completed");
    const retained = createRunDirectory("team", "reader", "run-retained");
    const unrelated = path.join(teamsRoot, "team", "notes.txt");
    fs.writeFileSync(unrelated, "keep");

    expect(cleanupPrivateAgentSessionDirectory("team", "reader", "run-completed")).toBe(true);

    expect(fs.existsSync(completed)).toBe(false);
    expect(fs.existsSync(retained)).toBe(true);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
  });

  it("removes only stale inactive runs while preserving active and recent recovery runs", () => {
    const now = Date.now();
    writeTeamConfig("team", [{ name: "reader", lifecycleRunId: "run-active", isActive: false }]);
    const active = createRunDirectory("team", "reader", "run-active");
    const stale = createRunDirectory("team", "reader", "run-stale");
    const recent = createRunDirectory("team", "reader", "run-recent");
    const old = new Date(now - PRIVATE_AGENT_SESSION_RETENTION_MS - 1_000);
    fs.utimesSync(path.join(active, "session.jsonl"), old, old);
    fs.utimesSync(active, old, old);
    fs.utimesSync(path.join(stale, "session.jsonl"), old, old);
    fs.utimesSync(stale, old, old);
    // The directory was admitted long ago, but its transcript was written recently.
    fs.utimesSync(recent, old, old);

    const cleaned = cleanupStalePrivateAgentSessions({ teamsRoot, now });

    expect(cleaned).toBe(1);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("continues cleaning later stale runs when one private-session removal fails", () => {
    const now = Date.now();
    writeTeamConfig("team");
    const failed = createRunDirectory("team", "reader", "run-failed");
    const cleaned = createRunDirectory("team", "reader", "run-cleaned");
    const old = new Date(now - PRIVATE_AGENT_SESSION_RETENTION_MS - 1_000);
    fs.utimesSync(path.join(failed, "session.jsonl"), old, old);
    fs.utimesSync(failed, old, old);
    fs.utimesSync(path.join(cleaned, "session.jsonl"), old, old);
    fs.utimesSync(cleaned, old, old);
    const originalRemove = fs.rmSync.bind(fs);
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((target: any, options?: any) => {
      if (target === failed) throw new Error("simulated removal failure");
      return originalRemove(target, options);
    });

    expect(cleanupStalePrivateAgentSessions({ teamsRoot, now })).toBe(1);
    expect(remove).toHaveBeenCalledWith(failed, { recursive: true, force: false });
    expect(fs.existsSync(failed)).toBe(true);
    expect(fs.existsSync(cleaned)).toBe(false);
  });

  it("retains an uninspectable stale run while cleaning separately inspectable stale runs", () => {
    const now = Date.now();
    writeTeamConfig("team");
    const uninspectable = createRunDirectory("team", "reader", "run-uninspectable");
    const inspectable = createRunDirectory("team", "reader", "run-inspectable");
    const uninspectableTranscript = path.join(uninspectable, "session.jsonl");
    const old = new Date(now - PRIVATE_AGENT_SESSION_RETENTION_MS - 1_000);
    fs.utimesSync(uninspectableTranscript, old, old);
    fs.utimesSync(uninspectable, old, old);
    fs.utimesSync(path.join(inspectable, "session.jsonl"), old, old);
    fs.utimesSync(inspectable, old, old);

    const originalLstat = fs.lstatSync.bind(fs) as any;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: any, ...args: any[]) => {
      if (String(target) === uninspectableTranscript) {
        throw Object.assign(new Error("simulated inspection failure"), { code: "EACCES" });
      }
      return originalLstat(target, ...args);
    }) as any);

    expect(cleanupStalePrivateAgentSessions({ teamsRoot, now })).toBe(1);
    expect(fs.existsSync(uninspectable)).toBe(true);
    expect(fs.existsSync(inspectable)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("refuses symlinked private-session directories", () => {
    writeTeamConfig("team");
    const external = path.join(root, "external");
    fs.mkdirSync(external);
    const privateRoot = path.join(teamsRoot, "team", "agent-sessions");
    fs.symlinkSync(external, privateRoot, "dir");

    expect(() => preparePrivateAgentSessionDirectory("team", "reader", "run-one"))
      .toThrow(/private agent session directory/i);
    expect(fs.readdirSync(external)).toEqual([]);
  });
});
