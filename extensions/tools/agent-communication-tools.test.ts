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
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function makeTools(teamName: string | null = "session", agentName = "reader", role: "read" | "write" = "read") {
  return new Map<string, Tool>(createAgentCommunicationTools({
    isTeammate: true,
    agentName,
    role,
    getTeamName: () => teamName ?? undefined,
    authorizeWriteMember: vi.fn(async () => {}),
    onReportAndExit: vi.fn(async () => ({ accepted: true })),
  } as any).map((tool: Tool) => [tool.name, tool]));
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

  it("exposes only simple direct communication tools to read agents", () => {
    const tools = Array.from(makeTools("session", "reader", "read").keys()).sort();

    expect(tools).toEqual(["read_inbox", "send_message"]);
  });

  it("exposes the complete coordination surface to write agents", () => {
    const tools = Array.from(makeTools("session", "writer", "write").keys()).sort();

    expect(tools).toEqual([
      "claim_file",
      "list_file_claims",
      "read_inbox",
      "release_file",
      "report_and_exit",
      "send_message",
    ]);
  });

  it("send_message uses the current session and defaults spawned agents to the lead", async () => {
    const tools = makeTools("session", "reader");

    const result = await tools.get("send_message")!.execute("send", {
      content: "I found something useful.",
      summary: "finding",
    });

    expect(result.details).toEqual({ session: "session", recipient: "team-lead" });
    const inbox = await readInbox("session", "team-lead", false, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "reader",
      text: "I found something useful.",
      summary: "finding",
      read: false,
    });
  });

  it("read_inbox reads the current agent inbox and records readiness", async () => {
    await sendPlainMessage("session", "team-lead", "reader", "Initial instructions", "assignment");
    const tools = makeTools("session", "reader");

    const result = await tools.get("read_inbox")!.execute("read", { unread_only: true });

    expect(result.content[0].text).toContain("Initial instructions");
    expect(result.details).toMatchObject({
      session: "session",
      targetAgent: "reader",
      messages: [expect.objectContaining({ from: "team-lead", text: "Initial instructions" })],
    });

    const inbox = await readInbox("session", "reader", false, false);
    expect(inbox[0].read).toBe(true);

    const status = await readRuntimeStatus("session", "reader");
    expect(status).toMatchObject({ teamName: "session", agentName: "reader", ready: true });
    expect(typeof status?.lastHeartbeatAt).toBe("number");
    expect(typeof status?.lastInboxReadAt).toBe("number");
  });

  it("read_inbox can peek without marking read or updating readiness", async () => {
    await sendPlainMessage("session", "team-lead", "reader", "Initial instructions", "assignment");
    const tools = makeTools("session", "reader");

    const result = await tools.get("read_inbox")!.execute("read", { unread_only: true, mark_as_read: false });

    expect(result.content[0].text).toContain("Initial instructions");
    expect(result.details.markAsRead).toBe(false);
    const inbox = await readInbox("session", "reader", false, false);
    expect(inbox[0].read).toBe(false);
    expect(await readRuntimeStatus("session", "reader")).toBeNull();
  });

  it("requires current session context for communication tools", async () => {
    const tools = makeTools(null, "reader");

    await expect(tools.get("send_message")!.execute("send", {
      content: "hello",
      summary: "hello",
    })).rejects.toThrow("No active agent session context is available.");
  });
});
