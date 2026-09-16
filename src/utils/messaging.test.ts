import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendMessage,
  broadcastMessage,
  broadcastMessageOnce,
  findInboxMessageByOperation,
  markInboxMessagesRead,
  peekInbox,
  removeInboxMessagesByOperationUnderLifecycleLock,
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

async function reloadMessagingWithIsolatedPaths() {
  const isolatedPaths = { ...paths };
  vi.resetModules();
  vi.doMock("./paths", () => isolatedPaths);
  try { return await import("./messaging.js"); }
  finally { vi.doUnmock("./paths"); }
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

  it.each(["append", "running", "once", "duplicate", "read", "tail", "remove"])("preserves grouped inbox durability during %s", async operation => {
    const groupOptions = { operationId: "group-delivery", metadata: { completionGroup: { groupId: "group", deliveryId: "group-delivery" } } };
    await sendPlainMessageOnce("test-team", "system", "team-lead", "Index", "Group", groupOptions);
    const perform = () => {
      if (operation === "read") return readInbox("test-team", "team-lead", true, true);
      if (operation === "tail") return readInboxTail("test-team", "team-lead", 1, { markAsRead: true });
      if (operation === "remove") return removeInboxMessagesByOperationUnderLifecycleLock("test-team", "team-lead", "group-delivery");
      if (operation === "duplicate") return sendPlainMessageOnce("test-team", "system", "team-lead", "Index", "Group", groupOptions);
      if (operation === "once") return sendPlainMessageOnce("test-team", "writer", "team-lead", "New", "New", { operationId: "ordinary" });
      return (operation === "running" ? sendPlainMessageIfRunning : sendPlainMessage)("test-team", "writer", "team-lead", "New", "New");
    };
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("group inbox sync failed"); });
    await expect(perform()).rejects.toThrow("group inbox sync failed");
    expect((await peekInbox("test-team", "team-lead"))[0]).toMatchObject({ text: "Index", read: false });
    sync.mockRestore();
    await perform();
    expect((await peekInbox("test-team", "team-lead")).length).toBe(operation === "remove" ? 0 : ["append", "running", "once"].includes(operation) ? 2 : 1);
  });

  it.each(["removal retry", "ordinary append"])("retains durability across reload for %s after uncertain last-index removal", async operation => {
    await sendPlainMessageOnce("test-team", "system", "team-lead", "Index", "Group", { operationId: "group-delivery", metadata: { completionGroup: {} } });
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("removal receipt uncertain");
      realSync(fd);
    });
    await expect(removeInboxMessagesByOperationUnderLifecycleLock("test-team", "team-lead", "group-delivery")).rejects.toThrow("removal receipt uncertain");
    expect(await peekInbox("test-team", "team-lead")).toEqual([]);
    const reloaded = await reloadMessagingWithIsolatedPaths();
    const remove = () => reloaded.removeInboxMessagesByOperationUnderLifecycleLock("test-team", "team-lead", "group-delivery");
    const append = () => reloaded.sendPlainMessageOnce("test-team", "writer", "team-lead", "Later", "Later", { operationId: "ordinary" });
    await expect(operation === "removal retry" ? remove() : append()).rejects.toThrow("removal receipt uncertain");
    sync.mockRestore();
    expect(await remove()).toBe(0);
    expect((await append()).delivered).toBe(operation === "removal retry");
    expect((await reloaded.peekInbox("test-team", "team-lead")).map(message => message.text)).toEqual(["Later"]);
  });

  it("keeps never-grouped inboxes on their ordinary atomic path", async () => {
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("durability not requested"); });
    await sendPlainMessageOnce("test-team", "sender", "receiver", "Ordinary", "Ordinary", { operationId: "ordinary" });
    expect((await readInbox("test-team", "receiver", true, true))[0]).toMatchObject({ text: "Ordinary", read: true });
    expect(await removeInboxMessagesByOperationUnderLifecycleLock("test-team", "receiver", "ordinary")).toBe(1);
    expect(fs.readdirSync(path.join(testDir, "inboxes"))).toEqual(["receiver.json"]);
    expect(sync).not.toHaveBeenCalled();
  });

  it("acknowledges exact delivered IDs without consuming later inbox messages", async () => {
    await sendPlainMessageOnce("test-team", "system", "team-lead", "Index", "Group", { id: "index", operationId: "group-delivery", metadata: { completionGroup: {} } });
    await sendPlainMessage("test-team", "writer", "team-lead", "Later", "Later");
    await markInboxMessagesRead("test-team", "team-lead", ["index"]);
    expect((await peekInbox("test-team", "team-lead", true)).map(message => message.text)).toEqual(["Later"]);
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("receipt sync failed"); });
    await expect(markInboxMessagesRead("test-team", "team-lead", ["index"])).rejects.toThrow("receipt sync failed");
    sync.mockRestore();
  });

  it("requires re-sync before acknowledging an uncertain grouped read receipt", async () => {
    await sendPlainMessageOnce("test-team", "system", "team-lead", "Index", "Group", { operationId: "group-delivery", metadata: { completionGroup: {} } });
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("read receipt uncertain");
      realSync(fd);
    });
    await expect(readInbox("test-team", "team-lead", true, true)).rejects.toThrow("read receipt uncertain");
    expect((await peekInbox("test-team", "team-lead"))[0].read).toBe(true);
    await expect(readInbox("test-team", "team-lead", true, true)).rejects.toThrow("read receipt uncertain");
    sync.mockRestore();
    expect(await readInbox("test-team", "team-lead", true, true)).toEqual([]);
  });

  it("never truncates a live inbox in place", async () => {
    await appendMessage("test-team", "receiver", { from: "sender", text: "first", timestamp: "now", read: false });
    const inboxFile = path.join(testDir, "inboxes", "receiver.json");
    const writes: string[] = [];
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target: any, data: any, options: any) => {
      writes.push(String(target));
      return realWriteFileSync(target, data, options);
    }) as typeof fs.writeFileSync);

    await appendMessage("test-team", "receiver", { from: "sender", text: "second", timestamp: "now", read: false });
    await readInbox("test-team", "receiver", true, true);

    expect(writes).not.toContain(inboxFile);
    expect((await readInbox("test-team", "receiver", false, false)).map(message => message.text)).toEqual(["first", "second"]);
    expect(fs.readdirSync(path.dirname(inboxFile)).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("broadcasts once to reachable members and reports the unreachable ones", async () => {
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({
      name: "test-team",
      members: [
        { name: "team-lead" },
        { name: "ghost", isActive: false },
        { name: "writer", isActive: true },
      ],
    }));

    const results = await broadcastMessageOnce("test-team", "team-lead", "ping", "broadcast", { operationId: "op-1" });

    expect(results.map(result => result.recipient).sort()).toEqual(["ghost", "writer"]);
    expect(results.find(result => result.recipient === "writer")?.delivered).toBe(true);
    expect(results.find(result => result.recipient === "ghost")).toMatchObject({
      delivered: false,
      error: expect.stringContaining("not running"),
    });
    expect((await readInbox("test-team", "writer", false, false)).length).toBe(1);
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
