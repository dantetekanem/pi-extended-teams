import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendMessage,
  broadcastMessage,
  findInboxMessageByOperation,
  peekInbox,
  readInbox,
  readInboxTail,
  sendPlainMessage,
  sendPlainMessageIfRunning,
  sendPlainMessageOnce,
} from "./messaging";
import type { InboxMessage } from "./models";
import * as paths from "./paths";
import { closePersistedRecipient } from "../../extensions/team/recipient-closure";

// Keep this suite isolated from task tests and parallel Vitest workers.
let testDir: string;

function writeInbox(agentName: string, messages: InboxMessage[]) {
  const inboxFilePath = path.join(testDir, "inboxes", `${agentName}.json`);
  fs.mkdirSync(path.dirname(inboxFilePath), { recursive: true });
  fs.writeFileSync(inboxFilePath, JSON.stringify(messages, null, 2));
}

describe("Messaging Utilities", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-messaging-"));
    
    // Override paths to use testDir
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => {
      return path.join(testDir, "inboxes", `${agentName}.json`);
    });
    vi.spyOn(paths, "teamDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockImplementation((teamName) => {
      return path.join(testDir, "config.json");
    });
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((_teamName, agentName) => {
      return path.join(testDir, "lifecycle", "quarantine", `${agentName}.json`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should append a message successfully", async () => {
    const msg = { from: "sender", text: "hello", timestamp: "now", read: false };
    await appendMessage("test-team", "receiver", msg);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(1);
    expect(inbox[0].text).toBe("hello");
  });

  it("should handle concurrent appends (Stress Test)", async () => {
    const numMessages = 100;
    const promises = [];
    for (let i = 0; i < numMessages; i++) {
      promises.push(sendPlainMessage("test-team", `sender-${i}`, "receiver", `msg-${i}`, `summary-${i}`));
    }
    
    await Promise.all(promises);
    
    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(numMessages);
    
    // Verify all messages are present
    const texts = inbox.map(m => m.text).sort();
    for (let i = 0; i < numMessages; i++) {
      expect(texts).toContain(`msg-${i}`);
    }
  });

  it("should mark messages as read", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");
    await sendPlainMessage("test-team", "sender", "receiver", "msg2", "summary2");
    
    // Read only unread messages
    const unread = await readInbox("test-team", "receiver", true, true);
    expect(unread.length).toBe(2);
    
    // Now all should be read
    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.length).toBe(2);
    expect(all.every(m => m.read)).toBe(true);
  });

  it("should mark large unread inboxes as read", async () => {
    const numMessages = 5000;
    const messages = Array.from({ length: numMessages }, (_, index) => ({
      from: "sender",
      text: `msg-${index}`,
      timestamp: `time-${index}`,
      read: index % 3 === 0,
    }));
    const expectedUnread = messages.filter((message) => !message.read).length;
    writeInbox("receiver", messages);

    const unread = await readInbox("test-team", "receiver", true, true);
    expect(unread.length).toBe(expectedUnread);
    expect(unread.every((message) => message.read)).toBe(true);

    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.length).toBe(numMessages);
    expect(all.every((message) => message.read)).toBe(true);
  });

  it("should read a bounded unread tail and mark only selected messages", async () => {
    writeInbox("receiver", [
      { from: "sender", text: "old-unread", timestamp: "time-1", read: false },
      { from: "sender", text: "already-read", timestamp: "time-2", read: true },
      { from: "sender", text: "middle-unread", timestamp: "time-3", read: false },
      { from: "sender", text: "new-unread", timestamp: "time-4", read: false },
    ]);

    const tail = await readInboxTail("test-team", "receiver", 2, { unreadOnly: true, markAsRead: true });
    expect(tail.map((message) => message.text)).toEqual(["middle-unread", "new-unread"]);
    expect(tail.every((message) => message.read)).toBe(true);

    const all = await readInbox("test-team", "receiver", false, false);
    expect(all.map((message) => [message.text, message.read])).toEqual([
      ["old-unread", false],
      ["already-read", true],
      ["middle-unread", true],
      ["new-unread", true],
    ]);
  });

  it("should isolate returned inbox messages from persisted inbox state", async () => {
    writeInbox("receiver", [
      {
        from: "sender",
        text: "original",
        timestamp: "time-1",
        read: false,
        metadata: { operationId: "op-1" },
      },
    ]);

    const inbox = await readInbox("test-team", "receiver", false, false);
    inbox[0].text = "mutated";
    inbox[0].metadata!.operationId = "mutated";

    const persisted = await readInbox("test-team", "receiver", false, false);
    expect(persisted[0].text).toBe("original");
    expect(persisted[0].metadata?.operationId).toBe("op-1");
  });

  it("should peek without marking messages as read", async () => {
    await sendPlainMessage("test-team", "sender", "receiver", "msg1", "summary1");

    const peeked = await peekInbox("test-team", "receiver", true);
    expect(peeked.length).toBe(1);
    expect(peeked[0].read).toBe(false);

    const unread = await readInbox("test-team", "receiver", true, false);
    expect(unread.length).toBe(1);
    expect(unread[0].read).toBe(false);
  });

  it("should send operation messages once", async () => {
    const first = await sendPlainMessageOnce("test-team", "sender", "receiver", "msg1", "summary1", { operationId: "op-1" });
    const second = await sendPlainMessageOnce("test-team", "sender", "receiver", "msg2", "summary2", { operationId: "op-1" });

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(false);
    expect(second.message.text).toBe("msg1");

    const inbox = await readInbox("test-team", "receiver", false, false);
    expect(inbox.length).toBe(1);
  });

  it("should find operation messages in top-level and metadata fields", async () => {
    writeInbox("receiver", [
      {
        from: "sender",
        text: "metadata operation",
        timestamp: "time-1",
        read: false,
        metadata: { operationId: "op-1", workflowRunId: "wf-1" },
      },
      {
        from: "sender",
        text: "top-level operation",
        timestamp: "time-2",
        read: false,
        operationId: "op-2",
      },
    ]);

    const metadataMessage = await findInboxMessageByOperation("test-team", "receiver", "op-1", "wf-1");
    expect(metadataMessage?.text).toBe("metadata operation");

    const topLevelMessage = await findInboxMessageByOperation("test-team", "receiver", "op-2");
    expect(topLevelMessage?.text).toBe("top-level operation");

    const mismatchedWorkflow = await findInboxMessageByOperation("test-team", "receiver", "op-1", "other-workflow");
    expect(mismatchedWorkflow).toBeUndefined();
  });

  it("orders a send that acquires the lifecycle fence before close", async () => {
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify({
      name: "test-team",
      members: [{ name: "receiver", lifecycleRunId: "receiver-run", isActive: true }],
    }));

    const delivery = sendPlainMessageIfRunning("test-team", "sender", "receiver", "before stop", "summary", undefined, {
      expectedRecipientRunId: "receiver-run",
    });
    const stop = closePersistedRecipient("test-team", "receiver", "receiver-run");
    await Promise.all([delivery, stop]);

    expect((await readInbox("test-team", "receiver", false, false)).map(message => message.text)).toEqual(["before stop"]);
    await expect(
      sendPlainMessageIfRunning("test-team", "sender", "receiver", "after stop", "summary")
    ).rejects.toThrow("lifecycle-quarantined");
  });

  it("rejects a send that follows close without creating or changing the inbox", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [{ name: "receiver", lifecycleRunId: "receiver-run", isActive: true }],
    }));
    await closePersistedRecipient("test-team", "receiver", "receiver-run");

    await expect(
      sendPlainMessageIfRunning("test-team", "sender", "receiver", "too late", "summary")
    ).rejects.toThrow("lifecycle-quarantined");
    expect(await readInbox("test-team", "receiver", false, false)).toEqual([]);
  });

  it("rejects occupied and corrupt lifecycle tombstones before inbox admission", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [{ name: "receiver", lifecycleRunId: "receiver-run", isActive: true }],
    }));
    const tombstonePath = paths.lifecycleTombstonePath("test-team", "receiver");
    fs.mkdirSync(path.dirname(tombstonePath), { recursive: true });
    fs.writeFileSync(tombstonePath, JSON.stringify({
      version: 1,
      team: "test-team",
      agent: "receiver",
      runId: "receiver-run",
      role: "read",
      reason: "quit",
      phase: "closing",
      ownerPid: process.pid,
      extensionInstanceId: "test-instance",
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
    }));
    await expect(sendPlainMessageIfRunning("test-team", "sender", "receiver", "blocked", "summary"))
      .rejects.toThrow("lifecycle-quarantined for run receiver-run");

    fs.writeFileSync(tombstonePath, "not-json");
    await expect(sendPlainMessageIfRunning("test-team", "sender", "receiver", "blocked", "summary"))
      .rejects.toThrow("corrupt tombstone");
    expect(await readInbox("test-team", "receiver", false, false)).toEqual([]);
  });

  it("should broadcast message to all members except the sender", async () => {
    // Setup team config
    const config = {
      name: "test-team",
      members: [
        { name: "sender" },
        { name: "member1" },
        { name: "member2" }
      ]
    };
    const configFilePath = path.join(testDir, "config.json");
    fs.writeFileSync(configFilePath, JSON.stringify(config));
    
    await broadcastMessage("test-team", "sender", "broadcast text", "summary");

    // Check member1's inbox
    const inbox1 = await readInbox("test-team", "member1", false, false);
    expect(inbox1.length).toBe(1);
    expect(inbox1[0].text).toBe("broadcast text");
    expect(inbox1[0].from).toBe("sender");

    // Check member2's inbox
    const inbox2 = await readInbox("test-team", "member2", false, false);
    expect(inbox2.length).toBe(1);
    expect(inbox2[0].text).toBe("broadcast text");
    expect(inbox2[0].from).toBe("sender");

    // Check sender's inbox (should be empty)
    const inboxSender = await readInbox("test-team", "sender", false, false);
    expect(inboxSender.length).toBe(0);
  });
});
