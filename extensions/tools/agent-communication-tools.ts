import { Type } from "@sinclair/typebox";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import { formatInboxMessagesForModel } from "../ui/renderers";
import { createFileClaimTools } from "./file-claim-tools";

export interface SubmittedAgentReport {
  content: string;
  summary?: string;
}

export interface AgentReportSubmissionResult {
  accepted: boolean;
}

export interface AgentCommunicationToolsOptions {
  isTeammate: boolean;
  agentName: string;
  role: "read" | "write";
  getTeamName(): string | null | undefined;
  authorizeWriteMember(teamName: string, agentName: string): Promise<void>;
  onReportAndExit(report: SubmittedAgentReport): Promise<AgentReportSubmissionResult>;
}

function requireCurrentSession(options: AgentCommunicationToolsOptions): string {
  const teamName = options.getTeamName();
  if (!teamName) throw new Error("No active agent session context is available.");
  return teamName;
}

export function createAgentCommunicationTools(options: AgentCommunicationToolsOptions): any[] {
  const communicationTools = [
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

  if (options.role !== "write") return communicationTools;

  const fileClaimTools = createFileClaimTools({
    agentName: options.agentName,
    getAuthorizedWriteTeam: async () => {
      const teamName = requireCurrentSession(options);
      await options.authorizeWriteMember(teamName, options.agentName);
      return teamName;
    },
    getCurrentTeam: () => requireCurrentSession(options),
    claims,
  });

  const reportAndExitTool = {
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Submit a final report to the lead and finish this nested edit-agent run.",
    parameters: Type.Object({
      content: Type.String({ description: "Final report to send to the lead." }),
      summary: Type.Optional(Type.String({ description: "Short report summary." })),
    }),
    async execute(_toolCallId: string, params: SubmittedAgentReport) {
      const teamName = requireCurrentSession(options);
      const result = await options.onReportAndExit({ content: params.content, summary: params.summary });
      const text = result.accepted
        ? "Final report accepted. Finish immediately; the outer runner will release claims and stop this nested session."
        : "A final report was already accepted for this run. This duplicate was ignored; finish immediately.";
      return { content: [{ type: "text", text }], details: { session: teamName, accepted: result.accepted } };
    },
  };

  return [...communicationTools, ...fileClaimTools, reportAndExitTool];
}
