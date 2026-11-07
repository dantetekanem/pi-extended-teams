import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import { AgentInbox } from "./agent-inbox";
import { readInbox, sendPlainMessage } from "./messaging";

let root: string;
const inboxes: AgentInbox[] = [];
function inbox(deliver?: (message: any) => Promise<void>) {
  const instance = new AgentInbox("team", "reader", "reader-run", deliver);
  inboxes.push(instance);
  return instance;
}
async function reply(id: string, overrides: Record<string, unknown> = {}, from = "writer") {
  await sendPlainMessage("team", from, "reader", "Use the existing API", "answer", undefined, {
    metadata: { replyTo: id, senderRunId: "writer-run", recipientRunId: "reader-run", ...overrides },
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-inbox-"));
  vi.spyOn(paths, "inboxPath").mockImplementation((_team, agent) => path.join(root, `${agent}.json`));
});
afterEach(() => {
  for (const item of inboxes.splice(0)) item.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("agent inbox", () => {
  it("wakes for a persisted message without a polling interval and acknowledges delivery once", async () => {
    let delivered!: () => void;
    const received = new Promise<void>(resolve => { delivered = resolve; });
    const receive = vi.fn(async (_message: unknown) => { delivered(); });
    const mailbox = inbox(receive);
    mailbox.start();
    await sendPlainMessage("team", "writer", "reader", "Evidence", "finding");
    await received;
    await mailbox.refresh();
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0][0]).toMatchObject({ from: "writer", text: "Evidence" });
  });

  it("resolves an early matching reply without steering it a second time", async () => {
    const receive = vi.fn();
    const mailbox = inbox(receive);
    const wait = mailbox.waitForReply("question", "writer", "writer-run", 60_000);
    await reply("question");
    expect(await wait).toMatchObject({ status: "replied", message: { text: "Use the existing API" } });
    await mailbox.refresh();
    expect(receive).not.toHaveBeenCalled();
    expect(await readInbox("team", "reader", true, false)).toEqual([]);
  });

  it("finds a matching reply even if inbox inspection already marked it read", async () => {
    await reply("question");
    await readInbox("team", "reader", true, true);
    const mailbox = inbox();
    const wait = mailbox.waitForReply("question", "writer", "writer-run", 1000);
    expect(await wait).toMatchObject({ status: "replied" });
  });

  it("does not let unrelated senders, old runs, or another request satisfy a wait", async () => {
    await reply("other");
    await reply("question", {}, "other-agent");
    await reply("question", { senderRunId: "old-run" });
    await reply("question", { recipientRunId: "old-reader-run" });
    vi.useFakeTimers();
    const mailbox = inbox();
    const wait = mailbox.waitForReply("question", "writer", "writer-run", 60_000);
    await mailbox.refresh();
    await vi.advanceTimersByTimeAsync(59_999);
    let settled = false;
    void wait.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await wait).toEqual({ status: "timed_out" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a wait and releases its timer and watcher", async () => {
    vi.useFakeTimers();
    const mailbox = inbox();
    const controller = new AbortController();
    const wait = mailbox.waitForReply("question", "writer", "writer-run", 60_000, controller.signal);
    const rejected = expect(wait).rejects.toThrow(/cancelled/);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers a late reply normally and closes outstanding waits on shutdown", async () => {
    vi.useFakeTimers();
    const receive = vi.fn(async () => {});
    const mailbox = inbox(receive);
    mailbox.start();
    const wait = mailbox.waitForReply("question", "writer", "writer-run", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await wait).toEqual({ status: "timed_out" });
    vi.useRealTimers();
    await reply("question");
    await mailbox.refresh();
    expect(receive).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    const pending = mailbox.waitForReply("next", "writer", "writer-run", 60_000);
    const rejected = expect(pending).rejects.toThrow(/closed/);
    mailbox.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
