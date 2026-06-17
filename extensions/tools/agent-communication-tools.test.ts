import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentCommunicationTools } from "./agent-communication-tools.js";
import * as paths from "../../src/utils/paths.js";
import { readInbox, sendPlainMessage } from "../../src/utils/messaging.js";
import { readRuntimeStatus } from "../../src/utils/runtime.js";

let root: string;

type Tool = {
  name: string;
  execute: (toolCallId: string, params: any) => Promise<any>;
};

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function writeTeamConfig(teamName: string, memberNames: string[]) {
  const configPath = paths.configPath(teamName);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    name: teamName,
    description: "test team",
    createdAt: Date.now(),
    leadAgentId: "lead-agent",
    leadSessionId: "session",
    members: memberNames.map(name => ({
      agentId: `${name}@${teamName}`,
      name,
      agentType: name === "team-lead" ? "lead" : "teammate",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    })),
  }, null, 2));
}

function makeTools(teamName: string | null = "team", agentName = "reader") {
  return new Map<string, Tool>(createAgentCommunicationTools({
    isTeammate: true,
    agentName,
    getTeamName: () => teamName ?? undefined,
  }).map((tool: Tool) => [tool.name, tool]));
}

describe("read-agent communication tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-agent-tools-"));
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("exposes only teammate-safe coordination tools", () => {
    const tools = Array.from(makeTools().keys()).sort();

    expect(tools).toEqual(["broadcast_message", "read_inbox", "request_teammate", "send_message"]);
  });

  it("send_message uses the current team when team_name is omitted", async () => {
    const tools = makeTools("team", "reader");

    const result = await tools.get("send_message")!.execute("send", {
      recipient: "team-lead",
      content: "I found something useful.",
      summary: "finding",
    });

    expect(result.details).toEqual({ teamName: "team", recipient: "team-lead" });
    const inbox = await readInbox("team", "team-lead", false, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "reader",
      text: "I found something useful.",
      summary: "finding",
      read: false,
    });
  });

  it("broadcast_message sends to every teammate except the sender", async () => {
    writeTeamConfig("team", ["team-lead", "reader", "writer"]);
    const tools = makeTools("team", "reader");

    const result = await tools.get("broadcast_message")!.execute("broadcast", {
      content: "Shared update",
      summary: "update",
      color: "purple",
    });

    expect(result.details).toEqual({ teamName: "team" });
    expect(await readInbox("team", "reader", false, false)).toEqual([]);
    for (const recipient of ["team-lead", "writer"]) {
      const inbox = await readInbox("team", recipient, false, false);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        from: "reader",
        text: "Shared update",
        summary: "update",
        color: "purple",
      });
    }
  });

  it("read_inbox reads the current agent inbox and records readiness", async () => {
    await sendPlainMessage("team", "team-lead", "reader", "Initial instructions", "assignment");
    const tools = makeTools("team", "reader");

    const result = await tools.get("read_inbox")!.execute("read", { unread_only: true });

    expect(result.content[0].text).toContain("Initial instructions");
    expect(result.details).toMatchObject({
      teamName: "team",
      targetAgent: "reader",
      messages: [expect.objectContaining({ from: "team-lead", text: "Initial instructions" })],
    });

    const inbox = await readInbox("team", "reader", false, false);
    expect(inbox[0].read).toBe(true);

    const status = await readRuntimeStatus("team", "reader");
    expect(status).toMatchObject({ teamName: "team", agentName: "reader", ready: true });
    expect(typeof status?.lastHeartbeatAt).toBe("number");
    expect(typeof status?.lastInboxReadAt).toBe("number");
  });

  it("request_teammate sends a lead-owned spawn request", async () => {
    const tools = makeTools("team", "reader");

    const result = await tools.get("request_teammate")!.execute("request", {
      name: "tester",
      prompt: "Validate the change",
      role: "read",
      reason: "Need another perspective",
    });

    expect(result.details).toMatchObject({
      requested: true,
      requestedAction: "spawn_teammate",
      teamName: "team",
      recipient: "team-lead",
      from: "reader",
    });
    const inbox = await readInbox("team", "team-lead", false, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "reader",
      summary: "Agent spawn request from reader for tester",
      color: "yellow",
    });
    expect(inbox[0].text).toContain("Requested action: spawn_teammate");
    expect(inbox[0].text).toContain("Need another perspective");
  });

  it("requires team context for communication tools", async () => {
    const tools = makeTools(null, "reader");

    await expect(tools.get("send_message")!.execute("send", {
      recipient: "team-lead",
      content: "hello",
      summary: "hello",
    })).rejects.toThrow("Cannot resolve team context without a current team or team_name.");
  });
});
