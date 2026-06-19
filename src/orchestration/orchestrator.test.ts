import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import * as messaging from "../utils/messaging";
import * as runtime from "../utils/runtime";
import { appendTeamReportEvent, listTeamReportEvents, observeTeam, observeTeammate, sendMessageOnce, spawnTeammateOnce } from "./index";

let root: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(root, "tasks", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "writeQueuePath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "write-queue.json"));
}

describe("orchestration primitives", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-orchestration-"));
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("observes teammate state without marking inbox read or mutating runtime/team state", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%1",
      cwd: root,
      subscriptions: [],
      prompt: "work",
    });
    await messaging.sendPlainMessage("team", "lead", "writer", "hello", "hello");
    await runtime.writeRuntimeStatus("team", "writer", { ready: true, lastHeartbeatAt: Date.now() });

    const observed = await observeTeammate("team", "writer", { terminal: { isAlive: () => false } });
    expect(observed.health).toBe("dead");
    expect(observed.unreadCount).toBe(1);

    const inbox = await messaging.readInbox("team", "writer", false, false);
    expect(inbox[0].read).toBe(false);
    expect(await runtime.readRuntimeStatus("team", "writer")).not.toBeNull();
    expect((await teams.readConfig("team")).members.some(member => member.name === "writer")).toBe(true);
  });

  it("reuses existing members for spawnTeammateOnce", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
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
      prompt: "read",
      metadata: { operationId: "op-1", workflowRunId: "run-1" },
    });
    const start = vi.fn();

    const result = await spawnTeammateOnce({
      teamName: "team",
      name: "reader",
      prompt: "read again",
      cwd: root,
      role: "read",
      operationId: "op-1",
      workflowRunId: "run-1",
    }, { start });

    expect(result.status).toBe("existing");
    expect(result.member?.name).toBe("reader");
    expect(start).not.toHaveBeenCalled();
  });

  it("replays durable report events through observeTeam", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await appendTeamReportEvent("team", {
      agentName: "reader",
      role: "read",
      status: "completed",
      report: "done",
      summary: "done",
      source: "read-agent",
      operationId: "op-1",
    });

    const replay = await listTeamReportEvents("team");
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ agentName: "reader", report: "done", operationId: "op-1" });

    const observation = await observeTeam("team");
    expect(observation.reports).toHaveLength(1);
  });

  it("sends orchestration messages once", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    await teams.addMember("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    });

    const first = await sendMessageOnce({ teamName: "team", fromName: "team-lead", toName: "reader", text: "one", summary: "one", operationId: "op-1" });
    const second = await sendMessageOnce({ teamName: "team", fromName: "team-lead", toName: "reader", text: "two", summary: "two", operationId: "op-1" });

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(false);
    expect((await messaging.peekInbox("team", "reader", false)).map(message => message.text)).toEqual(["one"]);
  });
});
