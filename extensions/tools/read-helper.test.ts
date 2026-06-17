import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCoordinationTools } from "./coordination-tools.js";
import * as paths from "../../src/utils/paths.js";
import * as teams from "../../src/utils/teams.js";
import { readInbox, sendPlainMessage } from "../../src/utils/messaging.js";
import { listReadHelperQueue } from "../../src/utils/read-helper-queue.js";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

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
  vi.spyOn(paths, "readHelperQueuePath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "read-helper-queue.json"));
  vi.spyOn(paths, "sharedMemoryPath").mockImplementation((teamName: unknown) => path.join(teamsRoot, paths.sanitizeName(String(teamName)), "shared-memory.json"));
}

function makeCtx() {
  return {
    cwd: root,
    modelRegistry: {
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
  };
}

async function createTeamWithMember(member: any) {
  teams.createTeam("team", "session", "lead", "", "provider/model");
  await teams.addMember("team", {
    agentId: `${member.name}@team`,
    name: member.name,
    agentType: "teammate",
    role: member.role,
    model: "provider/model",
    thinking: "high",
    joinedAt: Date.now(),
    tmuxPaneId: member.role === "write" ? "%1" : "",
    cwd: root,
    subscriptions: [],
  });
}

function registerTools(agentName = "writer", isTeammate = true) {
  const tools = new Map<string, RegisteredTool>();
  const runReadAgentInProcess = vi.fn();
  registerCoordinationTools({ registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) }, {
    agentName,
    isTeammate,
    terminal: null,
    getTeamName: () => "team",
    requireWriteAgentTeam: vi.fn(async () => "team"),
    requireTeamContext: vi.fn((explicit?: string) => explicit || "team"),
    releaseAllClaimsForAgent: vi.fn(async () => []),
    drainWriteQueue: vi.fn(async () => {}),
    resolveSkillFile: vi.fn(),
    adoptTeamAsLead: vi.fn(),
    renderLeadInboxStatus: vi.fn(async () => {}),
    resetLeadWakeNotifiedCount: vi.fn(),
  });
  return { tools, runReadAgentInProcess };
}

describe("request_read_helper", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-read-helper-"));
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

  it("lets a write agent queue a read-helper request without spawning from the writer process", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    const { tools, runReadAgentInProcess } = registerTools("writer", true);
    const ctx = makeCtx();

    const result = await tools.get("request_read_helper")!.execute("helper", {
      prompt: "Inspect the handoff contract.",
    }, new AbortController().signal, undefined, ctx);

    expect(result.details).toMatchObject({
      queued: true,
      teamName: "team",
      helperName: "writer-reader",
      requester: "writer",
      reportRecipient: "writer",
      leadNotificationRecipient: "team-lead",
    });

    const config = await teams.readConfig("team");
    expect(config.members.some(member => member.name === "writer-reader")).toBe(false);
    expect(runReadAgentInProcess).not.toHaveBeenCalled();

    const queue = await listReadHelperQueue("team");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      teamName: "team",
      requester: "writer",
      name: "writer-reader",
      prompt: "Inspect the handoff contract.",
      cwd: root,
      model: "provider/model",
      thinking: "high",
    });
  });

  it("pushes a lead-visible acknowledgement when a writer reads a helper report", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    const { tools } = registerTools("writer", true);
    await sendPlainMessage("team", "writer-reader", "writer", "0289cae Fix write agent spawn diagnostics", "Read helper writer-reader report", "cyan");

    await tools.get("read_inbox")!.execute("read", {
      team_name: "team",
      unread_only: true,
    }, new AbortController().signal, undefined, makeCtx());

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({
      from: "writer",
      summary: "writer received helper report",
      read: false,
    });
    expect(leadInbox[0].text).toContain("Received helper report from writer-reader; continuing.");
  });

  it("does not let the lead use request_read_helper as a replacement for spawn_teammate", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    const { tools, runReadAgentInProcess } = registerTools("team-lead", false);

    const result = await tools.get("request_read_helper")!.execute("helper", {
      prompt: "Inspect the handoff contract.",
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details).toEqual({ leadOnly: true });
    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("rejects read agents to avoid recursive helper spawning", async () => {
    await createTeamWithMember({ name: "reader", role: "read" });
    const { tools, runReadAgentInProcess } = registerTools("reader", true);

    await expect(tools.get("request_read_helper")!.execute("helper", {
      prompt: "Inspect the handoff contract.",
    }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow("request_read_helper is only available to write agents.");
    expect(runReadAgentInProcess).not.toHaveBeenCalled();
  });

  it("rejects duplicate explicit helper names", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    await teams.addMember("team", {
      agentId: "custom-helper@team",
      name: "custom-helper",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    });
    const { tools } = registerTools("writer", true);

    await expect(tools.get("request_read_helper")!.execute("helper", {
      name: "custom-helper",
      prompt: "Inspect the handoff contract.",
    }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow("Teammate custom-helper already exists");
  });

  it("uses queued helper names when generating default helper names", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    const { tools } = registerTools("writer", true);

    await tools.get("request_read_helper")!.execute("helper", {
      prompt: "First request.",
    }, new AbortController().signal, undefined, makeCtx());
    const result = await tools.get("request_read_helper")!.execute("helper", {
      prompt: "Second request.",
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details).toMatchObject({ helperName: "writer-reader-2" });
    const queue = await listReadHelperQueue("team");
    expect(queue.map(item => item.name)).toEqual(["writer-reader", "writer-reader-2"]);
  });

  it("rejects duplicate explicit names already queued", async () => {
    await createTeamWithMember({ name: "writer", role: "write" });
    const { tools } = registerTools("writer", true);

    await tools.get("request_read_helper")!.execute("helper", {
      name: "custom-helper",
      prompt: "First request.",
    }, new AbortController().signal, undefined, makeCtx());

    await expect(tools.get("request_read_helper")!.execute("helper", {
      name: "custom-helper",
      prompt: "Second request.",
    }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow("Read helper request custom-helper is already queued");
  });
});
