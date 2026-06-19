import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import { formatInboxMessagesForModel } from "../ui/renderers";
import { requestLeadForTeammateSpawn, resolveLeadRequestTeamName, type TeammateDelegationOptions } from "./delegation-guard";

export interface AgentCommunicationToolsOptions extends TeammateDelegationOptions {}

function requireTeamName(options: AgentCommunicationToolsOptions, explicitTeamName?: string): string {
  return resolveLeadRequestTeamName(options, explicitTeamName);
}

const teammateRequestParameters = Type.Object({
  team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
  name: Type.Optional(Type.String({ description: "Suggested teammate name." })),
  prompt: Type.String({ description: "The mission the lead should give the teammate if approved." }),
  role: Type.Optional(StringEnum(["read", "write"] as const, { description: "Requested role. Defaults to read unless the lead chooses otherwise." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the requested teammate." })),
  category: Type.Optional(Type.String({ description: "Optional category preset name." })),
  model: Type.Optional(Type.String({ description: "Optional fully qualified provider/model." })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
  plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
  reason: Type.Optional(Type.String({ description: "Why another teammate is needed." })),
});

export function createAgentCommunicationTools(options: AgentCommunicationToolsOptions): any[] {
  return [
    {
      name: "send_message",
      label: "Send Message",
      description: "Send a message to another teammate or the team lead.",
      parameters: Type.Object({
        team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
        recipient: Type.String(),
        content: Type.String(),
        summary: Type.String(),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireTeamName(options, params.team_name);
        await messaging.sendPlainMessage(teamName, options.agentName, params.recipient, params.content, params.summary);
        return { content: [{ type: "text", text: `Message sent to ${params.recipient}.` }], details: { teamName, recipient: params.recipient } };
      },
    },
    {
      name: "broadcast_message",
      label: "Broadcast Message",
      description: "Broadcast a message to all team members except the sender.",
      parameters: Type.Object({
        team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
        content: Type.String(),
        summary: Type.String(),
        color: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireTeamName(options, params.team_name);
        await messaging.broadcastMessage(teamName, options.agentName, params.content, params.summary, params.color);
        return { content: [{ type: "text", text: "Message broadcasted to all team members." }], details: { teamName } };
      },
    },
    {
      name: "read_inbox",
      label: "Read Inbox",
      description: "Read messages from this agent's inbox.",
      parameters: Type.Object({
        team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
        unread_only: Type.Optional(Type.Boolean({ default: true })),
        mark_as_read: Type.Optional(Type.Boolean({ default: true, description: "Set false to peek without marking messages read or updating runtime readiness." })),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireTeamName(options, params.team_name);
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
        return { content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }], details: { teamName, targetAgent: options.agentName, messages: msgs, markAsRead } };
      },
    },
    {
      name: "request_teammate",
      label: "Request Teammate",
      description: "Ask the team lead to spawn a teammate. Teammates cannot spawn, promote, or create agents directly.",
      parameters: teammateRequestParameters,
      async execute(_toolCallId: string, params: any) {
        return requestLeadForTeammateSpawn(options, {
          action: "spawn_teammate",
          params,
          reason: params.reason,
        });
      },
    },
  ];
}
