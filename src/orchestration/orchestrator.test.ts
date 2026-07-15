import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../utils/paths";
import * as teams from "../utils/teams";
import * as messaging from "../utils/messaging";
import * as runtime from "../utils/runtime";
import * as writeQueue from "../utils/write-queue";
import { appendTeamReportEvent, broadcastMessageOnce, ensureTeam, listTeamReportEvents, observeTeam, observeTeammate, sendMessageOnce, spawnTeammateOnce, spawnTeammatesOnce } from "./index";
import { roleForFavoriteModelSlot } from "../utils/settings";
import type { SpawnTeammateOnceRequest } from "./types";

let root: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "taskDir").mockImplementation((teamName: unknown) => path.join(root, "tasks", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`));
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "claims.json"));
  vi.spyOn(paths, "writeQueuePath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "write-queue.json"));
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`));
}

function writeFavoriteLevels() {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "reading-default": { model: "provider/model", thinking: "high" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
    },
  }));
}

describe("orchestration primitives", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-orchestration-"));
    vi.spyOn(os, "homedir").mockReturnValue(root);
    installPathSpies();
    writeFavoriteLevels();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses read-review as the canonical team default while loading its legacy settings alias", async () => {
    const result = await ensureTeam({ teamName: "default-tier-team", description: "default tier" });

    expect(result.created).toBe(true);
    expect(result.config.defaultModel).toBe("provider/model");
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
    const writerRunId = (await teams.readConfig("team")).members.find(member => member.name === "writer")!.lifecycleRunId!;
    await messaging.sendPlainMessage("team", "lead", "writer", "hello", "hello");
    await runtime.writeRuntimeStatus("team", "writer", writerRunId, { ready: true, lastHeartbeatAt: Date.now() });

    const observed = await observeTeammate("team", "writer", { terminal: { isAlive: () => false } });
    expect(observed.health).toBe("dead");
    expect(observed.unreadCount).toBe(1);

    const inbox = await messaging.readInbox("team", "writer", false, false);
    expect(inbox[0].read).toBe(false);
    expect(await runtime.readRuntimeStatus("team", "writer")).not.toBeNull();
    expect((await teams.readConfig("team")).members.some(member => member.name === "writer")).toBe(true);
  });

  it("observes high-volume teams without rereading config per member", async () => {
    const config = teams.createTeam("team", "session", "lead", "", "provider/model");
    config.members.push(...Array.from({ length: 150 }, (_, index) => ({
      agentId: `reader-${index}@team`,
      name: `reader-${index}`,
      agentType: "teammate",
      role: "read" as const,
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "read",
    })));
    fs.writeFileSync(paths.configPath("team"), JSON.stringify(config, null, 2));
    const readConfigSpy = vi.spyOn(teams, "readConfig");

    const observation = await observeTeam("team");

    expect(observation.members).toHaveLength(151);
    expect(readConfigSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses existing members with canonical outward slots without rewriting persisted state", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const joinedAt = Date.now();
    const persistedMember = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write" as const,
      model: "provider/model",
      thinking: "xhigh" as const,
      modelSlot: "writing-hard",
      joinedAt,
      tmuxPaneId: "%1",
      cwd: root,
      subscriptions: [],
      prompt: "write",
      metadata: { operationId: "op-1", workflowRunId: "run-1", modelSlot: "writing-hard" },
    };
    await teams.addMember("team", persistedMember);
    const start = vi.fn();

    const result = await spawnTeammateOnce({
      teamName: "team",
      name: "writer",
      prompt: "write again",
      cwd: root,
      modelSlot: "writing-hard",
      operationId: "op-1",
      workflowRunId: "run-1",
    }, { start });

    expect(result).toEqual({
      status: "existing",
      member: {
        ...persistedMember,
        modelSlot: "write-system",
        metadata: { operationId: "op-1", workflowRunId: "run-1", modelSlot: "write-system" },
      },
      details: {
        agentId: "writer@team",
        role: "write",
        requestedRole: "write",
        resolvedRole: "write",
        requestedModelSlot: "write-system",
        modelSlot: "write-system",
        model: "provider/model",
        thinking: "xhigh",
        existing: true,
        idempotent: true,
        queued: false,
        modelSource: "existing",
      },
    });
    expect((await teams.readConfig("team")).members.find(member => member.name === "writer")).toMatchObject({
      modelSlot: "writing-hard",
      metadata: { modelSlot: "writing-hard" },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("bulk spawn once reuses one config and queue scan for high-volume requests", async () => {
    const config = teams.createTeam("team", "session", "lead", "", "provider/model");
    config.members.push({
      agentId: "existing-reader@team",
      name: "existing-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "read",
      metadata: { operationId: "op-existing", workflowRunId: "run-1" },
    });
    fs.writeFileSync(paths.configPath("team"), JSON.stringify(config, null, 2));
    await writeQueue.enqueueWriteSpawn("team", {
      name: "queued-reader",
      prompt: "queued",
      cwd: root,
      modelSlot: "writing-hard",
      operationId: "op-queued",
      workflowRunId: "run-1",
    });

    const startRequests: SpawnTeammateOnceRequest[] = Array.from({ length: 120 }, (_, index) => ({
      teamName: "team",
      name: `reader-${index}`,
      prompt: "read",
      cwd: root,
      modelSlot: "reading-default",
      operationId: `op-start-${index}`,
      workflowRunId: "run-1",
    }));
    const requests: SpawnTeammateOnceRequest[] = [
      { teamName: "team", name: "existing-reader", prompt: "read", cwd: root, modelSlot: "reading-default" },
      { teamName: "team", name: "operation-match", prompt: "read", cwd: root, modelSlot: "reading-default", operationId: "op-existing", workflowRunId: "run-1" },
      { teamName: "team", name: "queued-reader", prompt: "queued", cwd: root, modelSlot: "writing-hard", operationId: "op-queued", workflowRunId: "run-1" },
      ...startRequests,
      { teamName: "team", name: "reader-0", prompt: "duplicate", cwd: root, modelSlot: "reading-default", operationId: "op-duplicate-name", workflowRunId: "run-1" },
      { teamName: "team", name: "reader-via-op", prompt: "duplicate", cwd: root, modelSlot: "reading-default", operationId: "op-start-1", workflowRunId: "run-1" },
    ];
    const start = vi.fn(async (request: SpawnTeammateOnceRequest) => ({
      member: {
        agentId: `${request.name}@${request.teamName}`,
        name: request.name,
        agentType: "teammate",
        role: roleForFavoriteModelSlot(request.modelSlot),
        model: "provider/model",
        modelSlot: request.modelSlot,
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: request.cwd,
        subscriptions: [],
        prompt: request.prompt,
        metadata: request.metadata,
      },
    }));
    const readConfigSpy = vi.spyOn(teams, "readConfig");
    const listQueueSpy = vi.spyOn(writeQueue, "listWriteQueue");

    const results = await spawnTeammatesOnce(requests, { start });

    expect(results).toHaveLength(requests.length);
    expect(results[0]).toMatchObject({ status: "existing", member: { name: "existing-reader" } });
    expect(results[1]).toMatchObject({ status: "existing", member: { name: "existing-reader" } });
    expect(results[2]).toMatchObject({ status: "queued", queued: { name: "queued-reader" } });
    expect(results[3]).toMatchObject({ status: "started", member: { name: "reader-0" } });
    expect(results.at(-2)).toMatchObject({ status: "existing", member: { name: "reader-0" } });
    expect(results.at(-1)).toMatchObject({ status: "existing", member: { name: "reader-1" } });
    expect(start).toHaveBeenCalledTimes(startRequests.length);
    expect(start.mock.calls[0][0].metadata).toMatchObject({ operationId: "op-start-0", workflowRunId: "run-1" });
    expect(readConfigSpy).toHaveBeenCalledTimes(1);
    expect(listQueueSpy).toHaveBeenCalledTimes(1);
  });

  it("synthesizes effective spawn details from start callback results", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const startedMember = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write" as const,
      model: "provider/model",
      thinking: "xhigh" as const,
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "%1",
      cwd: root,
      subscriptions: [],
    };

    const result = await spawnTeammateOnce({
      teamName: "team",
      name: "writer",
      prompt: "write",
      cwd: root,
      modelSlot: "writing-hard",
      operationId: "op-2",
      workflowRunId: "run-1",
    }, {
      start: vi.fn(async () => ({ member: startedMember, details: { queued: false, terminalId: "%1", modelSource: "favorite-slot" } })),
    });

    expect(result.status).toBe("started");
    expect(result.details).toMatchObject({
      role: "write",
      requestedRole: "write",
      resolvedRole: "write",
      requestedModelSlot: "write-system",
      modelSlot: "write-system",
      model: "provider/model",
      thinking: "xhigh",
      modelSource: "favorite-slot",
      queued: false,
      terminalId: "%1",
    });
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

  it("records high-volume report events without lock retry backoff", async () => {
    teams.createTeam("team", "session", "lead", "", "provider/model");
    const reportCount = 200;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const writes = Array.from({ length: reportCount }, (_, index) => appendTeamReportEvent("team", {
      agentName: `reader-${index}`,
      role: "read",
      status: "completed",
      report: `report-${index}`,
      summary: `reader-${index} done`,
      source: "read-agent",
      operationId: `op-report-${index}`,
      workflowRunId: "run-1",
      createdAt: index + 1,
    }));

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    const written = await Promise.all(writes);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(written).toHaveLength(reportCount);
    expect(new Set(written.map((event) => event.id)).size).toBe(reportCount);

    const replay = await listTeamReportEvents("team");
    expect(replay).toHaveLength(reportCount);
    expect(replay[0]).toMatchObject({ agentName: "reader-0", operationId: "op-report-0", createdAt: 1 });
    expect(replay.at(-1)).toMatchObject({ agentName: "reader-199", operationId: "op-report-199", createdAt: 200 });

    const observation = await observeTeam("team", { reportLimit: 5 });
    expect(observation.reports.map((event) => event.operationId)).toEqual([
      "op-report-195",
      "op-report-196",
      "op-report-197",
      "op-report-198",
      "op-report-199",
    ]);
  });

  it("sends and broadcasts orchestration messages once through active-recipient admission", async () => {
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

    await teams.addMember("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    });
    const firstBroadcast = await broadcastMessageOnce({
      teamName: "team",
      fromName: "team-lead",
      text: "broadcast one",
      summary: "broadcast",
      operationId: "broadcast-op",
    });
    const secondBroadcast = await broadcastMessageOnce({
      teamName: "team",
      fromName: "team-lead",
      text: "broadcast two",
      summary: "broadcast",
      operationId: "broadcast-op",
    });
    expect(firstBroadcast.every(result => result.delivered)).toBe(true);
    expect(secondBroadcast.every(result => !result.delivered)).toBe(true);
    expect((await messaging.peekInbox("team", "writer", false)).map(message => message.text)).toEqual(["broadcast one"]);
  });
});
