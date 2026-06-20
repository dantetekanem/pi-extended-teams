import { Type } from "@sinclair/typebox";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import { formatInboxMessagesForModel } from "../ui/renderers";

export interface AgentCommunicationToolsOptions {
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
}

function requireCurrentSession(options: AgentCommunicationToolsOptions): string {
  const teamName = options.getTeamName();
  if (!teamName) throw new Error("No active agent session context is available.");
  return teamName;
}

export function createAgentCommunicationTools(options: AgentCommunicationToolsOptions): any[] {
  return [
    {
      name: "send_message",
      label: "Send Message",
      description: "Send a direct message in the current Pi session. Spawned agents default to messaging the lead.",
      parameters: Type.Object({
        recipient: Type.Optional(Type.String({ description: "Recipient agent name. Defaults to team-lead for spawned agents." })),
        content: Type.String(),
        summary: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireCurrentSession(options);
        const recipient = params.recipient || (options.isTeammate ? "team-lead" : undefined);
        if (!recipient) throw new Error("recipient is required when the lead sends a message.");
        await messaging.sendPlainMessage(teamName, options.agentName, recipient, params.content, params.summary || "Message");
        return { content: [{ type: "text", text: `Message sent to ${recipient}.` }], details: { session: teamName, recipient } };
      },
    },
    {
      name: "read_inbox",
      label: "Read Inbox",
      description: "Read this agent's inbox in the current Pi session.",
      parameters: Type.Object({
        unread_only: Type.Optional(Type.Boolean({ default: true })),
        mark_as_read: Type.Optional(Type.Boolean({ default: true, description: "Set false to peek without marking messages read." })),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireCurrentSession(options);
        const markAsRead = params.mark_as_read !== false;
        const msgs = await messaging.readInbox(teamName, options.agentName, params.unread_only, markAsRead);
        if (markAsRead) {
          await runtime.writeRuntimeStatus(teamName, options.agentName, {
            lastHeartbeatAt: Date.now(),
            lastInboxReadAt: Date.now(),
            ready: true,
            lastError: undefined,
          }).catch(() => {});
        }
        return { content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }], details: { session: teamName, targetAgent: options.agentName, messages: msgs, markAsRead } };
      },
    },
  ];
}
