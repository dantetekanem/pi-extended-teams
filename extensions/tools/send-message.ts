import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { AgentInbox, type ReplyResult } from "../../src/utils/agent-inbox";
import { buildInboxMessage, appendMessageOnceIfRunning, readInbox, requireRunningMessageRecipient } from "../../src/utils/messaging";
import { readConfig } from "../../src/utils/teams";
import type { InboxMessage } from "../../src/utils/models";

export interface SendMessageOptions {
  agentName: string;
  isTeammate: boolean;
  getTeamName(): string | null | undefined;
  getLifecycleRunId?(): string | undefined;
  inbox?: AgentInbox;
  onWait?(recipient: string, waiting: boolean): void;
  notifySent?(teamName: string, recipient: string, message: InboxMessage): Promise<void>;
}
interface SendMessageParams {
  recipient?: string;
  content: string;
  summary?: string;
  reply_to?: string;
  wait_for_reply?: boolean;
  timeout_seconds?: number;
}

export function createSendMessageTool(options: SendMessageOptions) {
  return {
    name: "send_message",
    label: "Send Message",
    description: "Send a message to the coordinator or a running teammate in this session. Use reply_to to answer a message. Optionally wait for a correlated reply for at most 60 seconds; timeout is not an answer or permission.",
    parameters: Type.Object({
      recipient: Type.Optional(Type.String({ description: "Recipient agent name; defaults to team-lead for spawned agents." })),
      content: Type.String(),
      summary: Type.Optional(Type.String()),
      reply_to: Type.Optional(Type.String({ description: "ID of the received message being answered." })),
      wait_for_reply: Type.Optional(Type.Boolean({ description: "Suspend this tool until the reply arrives or the timeout expires. No polling needed." })),
      timeout_seconds: Type.Optional(Type.Number({ minimum: 1, description: "Reply wait duration; defaults to 60 seconds and is capped at 60." })),
    }),
    async execute(_toolCallId: string, params: SendMessageParams, signal?: AbortSignal) {
      const teamName = options.getTeamName();
      if (!teamName) throw new Error("No active agent session context is available.");
      if (signal?.aborted) throw new Error("Message cancelled.");
      const recipient = params.recipient || (options.isTeammate ? "team-lead" : undefined);
      if (!recipient) throw new Error("recipient is required when the lead sends a message.");
      const seconds = params.timeout_seconds ?? 60;
      if (!Number.isFinite(seconds) || seconds < 1) throw new Error("timeout_seconds must be a finite positive number of at least 1.");
      const timeoutSeconds = Math.min(seconds, 60);
      await requireRunningMessageRecipient(teamName, recipient);
      const config = await readConfig(teamName);
      const sender = config.members.find(member => member.name === options.agentName);
      const senderRunId = options.getLifecycleRunId?.() ?? sender?.lifecycleRunId;
      if (options.isTeammate && (!sender || sender.isActive === false || sender.lifecycleRunId !== senderRunId)) {
        throw new Error("Cannot send from an inactive or stale agent run.");
      }
      const recipientRunId = config.members.find(member => member.name === recipient)?.lifecycleRunId;
      if (params.reply_to) {
        const original = (await readInbox(teamName, options.agentName, false, false)).find(message => message.id === params.reply_to);
        if (!original || original.from !== recipient
          || (original.metadata?.recipientRunId && original.metadata.recipientRunId !== senderRunId)
          || (original.metadata?.senderRunId && original.metadata.senderRunId !== recipientRunId)) {
          throw new Error("reply_to must identify a message from this recipient to the current agent run.");
        }
      }
      const messageId = randomUUID();
      const message = buildInboxMessage(options.agentName, params.content, params.summary || "Message", {
        id: messageId,
        metadata: { senderRunId, recipientRunId, replyTo: params.reply_to, expectsReply: params.wait_for_reply === true },
      });
      const inbox = options.inbox ?? new AgentInbox(teamName, options.agentName, senderRunId);
      const cancellation = new AbortController();
      const abort = () => cancellation.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let reply: ReturnType<AgentInbox["waitForReply"]> | undefined;
      try {
        if (params.wait_for_reply) {
          reply = inbox.waitForReply(messageId, recipient, recipientRunId, timeoutSeconds * 1000, cancellation.signal);
          // Persistence can fail while the listener is open; always observe cancellation.
          void reply.catch(() => {});
          options.onWait?.(recipient, true);
        }
        if (signal?.aborted) throw new Error("Message cancelled.");
        let persisted = false;
        const delivery = (async () => {
          await appendMessageOnceIfRunning(teamName, recipient, { ...message, operationId: messageId }, {
            expectedRecipientRunId: recipientRunId,
          });
          persisted = true;
          if (!cancellation.signal.aborted) await options.notifySent?.(teamName, recipient, message);
        })();
        let result: ReplyResult | undefined;
        // A pending append/notifier must not hold the wait past its deadline or cancellation.
        // The race also observes delivery failures after the wait has settled.
        if (reply) {
          result = await Promise.race([reply, delivery.then(() => reply)]);
        } else {
          await delivery;
        }
        const status = result?.status ?? "sent";
        const text = result?.status === "replied"
          ? `Reply from ${result.message.from}:\n${result.message.text}`
          : status === "timed_out"
            ? "No reply before the deadline. Continue only independent work within your assignment. Keep essential unanswered decisions blocked; silence grants no permission."
            : `Message sent to ${recipient}.`;
        const storageWarning = persisted ? "" : "\nMessage storage is still pending; delivery is unconfirmed.";
        return {
          content: [{ type: "text" as const, text: `${text}${storageWarning}\nMessage ID: ${messageId}` }],
          details: {
            session: teamName,
            recipient,
            messageId,
            status,
            persisted,
            ...(reply ? { timeoutSeconds } : {}),
            ...(result?.status === "replied" ? { reply: result.message } : {}),
          },
        };
      } finally {
        cancellation.abort();
        signal?.removeEventListener("abort", abort);
        if (reply) options.onWait?.(recipient, false);
        if (!options.inbox) inbox.close();
      }
    },
  };
}
