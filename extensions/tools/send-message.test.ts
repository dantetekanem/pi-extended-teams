import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as paths from "../../src/utils/paths";
import { AgentInbox } from "../../src/utils/agent-inbox";
import { readInbox } from "../../src/utils/messaging";
import * as messaging from "../../src/utils/messaging";
import { createSendMessageTool } from "./send-message";

let root: string;
const inboxes: AgentInbox[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "send-message-"));
  vi.spyOn(paths, "configPath").mockReturnValue(path.join(root, "config.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((_team, agent) => path.join(root, "inboxes", `${agent}.json`));
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((_team, agent) => path.join(root, "fences", `${agent}.json`));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ members: [
    { name: "team-lead", isActive: true },
    { name: "reader", isActive: true, lifecycleRunId: "reader-run" },
    { name: "writer", isActive: true, lifecycleRunId: "writer-run" },
  ] }));
});
afterEach(() => {
  for (const item of inboxes.splice(0)) item.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function tool(agentName: string, extra: Partial<Parameters<typeof createSendMessageTool>[0]> = {}) {
  return createSendMessageTool({
    isTeammate: agentName !== "team-lead",
    agentName,
    getTeamName: () => "team",
    getLifecycleRunId: () => agentName === "team-lead" ? undefined : `${agentName}-run`,
    ...extra,
  });
}

it("round-trips a clarification through identified peer messages without a lead relay", async () => {
  const readerInbox = new AgentInbox("team", "reader", "reader-run");
  inboxes.push(readerInbox);
  const writer = tool("writer", { notifySent: () => readerInbox.refresh() });
  const errors: unknown[] = [];
  const peer = new AgentInbox("team", "writer", "writer-run", async message => {
    await writer.execute("answer", { recipient: message.from, reply_to: message.id, content: "Use the existing API" });
  }, error => errors.push(error));
  inboxes.push(peer);
  peer.start();
  const onWait = vi.fn();
  const result = await tool("reader", { onWait, inbox: readerInbox, notifySent: () => peer.refresh() }).execute("question", {
    recipient: "writer", content: "Which API?", wait_for_reply: true, timeout_seconds: 1,
  });
  expect(errors).toEqual([]);
  expect(result.details).toMatchObject({ status: "replied", reply: { from: "writer", text: "Use the existing API" } });
  expect(onWait).toHaveBeenCalledWith("writer", true);
  expect(onWait).toHaveBeenLastCalledWith("writer", false);
  const [question] = await readInbox("team", "writer", false, false);
  expect(question.metadata).toMatchObject({ senderRunId: "reader-run", recipientRunId: "writer-run", expectsReply: true });
  expect(result.details.reply?.metadata?.replyTo).toBe(question.id);
});

it("caps a requested wait at 60 seconds and returns timeout rather than an invented answer", async () => {
  let waiting!: () => void;
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  vi.useFakeTimers();
  const sender = tool("reader", {
    onWait: (_recipient, active) => { if (active) waiting(); },
  });
  const sending = sender.execute("question", {
    content: "Need clarification", wait_for_reply: true, timeout_seconds: 600,
  });
  await ready;
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await sending).details).toMatchObject({ status: "timed_out", timeoutSeconds: 60 });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["append", "cancel"], ["append", "timeout"],
  ["notification", "cancel"], ["notification", "timeout"],
])("settles on %s-pending %s without waiting for delivery", async (phase, ending) => {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pause = async () => {
    entered.resolve();
    await release.promise;
  };
  const append = messaging.appendMessageOnceIfRunning;
  const pending: Promise<unknown>[] = [];
  vi.spyOn(messaging, "appendMessageOnceIfRunning").mockImplementation((...args) => {
    const operation = (async () => {
      if (phase === "append") await pause();
      return append(...args);
    })();
    pending.push(operation);
    return operation;
  });
  const notifySent = vi.fn(async () => {
    if (phase === "notification") await pause();
  });
  const onWait = vi.fn();
  const cancelled = new AbortController();
  const succeeded = vi.fn();
  const failed = vi.fn();
  const sending = tool("reader", { notifySent, onWait }).execute("question", {
    content: "Need clarification", wait_for_reply: true, timeout_seconds: 1,
  }, cancelled.signal).then(succeeded, failed);
  try {
    await entered.promise;
    if (ending === "cancel") cancelled.abort();
    await vi.advanceTimersByTimeAsync(ending === "timeout" ? 1_000 : 0);
    if (ending === "cancel") {
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/cancel/i) }));
    } else {
      expect(succeeded).toHaveBeenCalledOnce();
      expect(succeeded.mock.calls[0][0].details).toMatchObject({
        status: "timed_out", persisted: phase !== "append",
      });
    }
    expect(onWait).toHaveBeenLastCalledWith("team-lead", false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await sending;
  }
  if (phase === "append") expect(notifySent).not.toHaveBeenCalled();
  expect(await readInbox("team", "team-lead", false, false)).toHaveLength(1);
});

it("rejects stale senders and replies to a different recipient before persisting", async () => {
  await expect(tool("reader", { getLifecycleRunId: () => "old-run" }).execute("stale", { content: "Question" })).rejects.toThrow(/run/);
  await expect(tool("writer").execute("reply", { recipient: "reader", content: "Answer", reply_to: "unknown" })).rejects.toThrow(/reply/i);
  expect(await readInbox("team", "reader", false, false)).toEqual([]);
});

it("cancels without sending when already aborted and rejects invalid wait values", async () => {
  const signal = AbortSignal.abort();
  await expect(tool("reader").execute("cancelled", { content: "Question", wait_for_reply: true }, signal)).rejects.toThrow(/cancel/i);
  await expect(tool("reader").execute("invalid", { content: "Question", wait_for_reply: true, timeout_seconds: -1 })).rejects.toThrow(/timeout/i);
  expect(await readInbox("team", "team-lead", false, false)).toEqual([]);
});
