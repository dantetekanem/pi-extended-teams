import fs from "node:fs";
import path from "node:path";
import type { InboxMessage } from "./models";
import { inboxPath } from "./paths";
import { markInboxMessagesRead, readInbox } from "./messaging";

export type ReplyResult = { status: "replied"; message: InboxMessage } | { status: "timed_out" };
interface ReplyWait {
  sender: string;
  senderRunId?: string;
  finish(result: ReplyResult | Error): void;
}

/** One run's event-driven inbox; reply waits bypass queued model delivery. */
export class AgentInbox {
  private watcher?: fs.FSWatcher;
  private closed = false;
  private dirty = false;
  private refreshing?: Promise<void>;
  private delivering = new Set<string>();
  private waits = new Map<string, ReplyWait>();

  constructor(
    private teamName: string,
    private agentName: string,
    private runId?: string,
    private deliver?: (message: InboxMessage) => Promise<void>,
    private onError: (error: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.closed) throw new Error("Agent inbox is closed.");
    if (this.watcher) return;
    const file = inboxPath(this.teamName, this.agentName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.watcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (!filename || filename.toString() === path.basename(file)) this.requestRefresh();
    });
    this.watcher.on("error", error => {
      this.onError(error);
      this.close(error);
    });
    this.requestRefresh();
  }

  private requestRefresh(): void {
    void this.refresh().catch(error => {
      this.onError(error);
      this.close(error);
    });
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    return this.refreshing ??= this.scan().finally(() => {
      this.refreshing = undefined;
    });
  }

  private async scan(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const messages = await readInbox(this.teamName, this.agentName, false, false);
      for (const message of messages) {
        if (this.closed) return;
        if (message.metadata?.recipientRunId && message.metadata.recipientRunId !== this.runId) continue;
        const wait = this.waits.get(message.metadata?.replyTo);
        if (wait && message.from === wait.sender && (!wait.senderRunId || message.metadata?.senderRunId === wait.senderRunId)) {
          wait.finish({ status: "replied", message });
          await markInboxMessagesRead(this.teamName, this.agentName, [message.id!]);
          continue;
        }
        if (message.read || !this.deliver || !message.id || this.delivering.has(message.id)) continue;
        this.delivering.add(message.id);
        void this.deliver(message).then(async () => {
          if (!this.closed) await markInboxMessagesRead(this.teamName, this.agentName, [message.id!]);
        }).catch(error => {
          if (!this.closed) this.onError(error);
        }).finally(() => {
          this.delivering.delete(message.id!);
        });
      }
    }
  }

  waitForReply(id: string, sender: string, senderRunId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ReplyResult> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new Error("Reply wait must be between 1 and 60000 milliseconds.");
    }
    if (signal?.aborted) return Promise.reject(new Error("Reply wait cancelled."));
    if (this.waits.has(id)) throw new Error("Already waiting for this reply.");
    this.start();
    return new Promise((resolve, reject) => {
      const abort = () => wait.finish(new Error("Reply wait cancelled."));
      const timer = setTimeout(() => wait.finish({ status: "timed_out" }), timeoutMs);
      const wait: ReplyWait = {
        sender,
        senderRunId,
        finish: result => {
          if (this.waits.get(id) !== wait) return;
          this.waits.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (!this.deliver && this.waits.size === 0) {
            this.watcher?.close();
            this.watcher = undefined;
          }
          if (result instanceof Error) reject(result);
          else resolve(result);
        },
      };
      this.waits.set(id, wait);
      signal?.addEventListener("abort", abort, { once: true });
      this.requestRefresh();
    });
  }

  close(error = new Error("Agent inbox closed.")): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const wait of this.waits.values()) wait.finish(error);
  }
}
