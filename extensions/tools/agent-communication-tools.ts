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
  cancelledDeliveries?: number;
  deliveryOutcome?: "cancelled" | "none";
}

export interface AgentCommunicationToolsOptions {
  isTeammate: boolean;
  agentName: string;
  role: "read" | "write";
  getTeamName(): string | null | undefined;
  getLifecycleRunId(): string | undefined;
  authorizeWriteMember(teamName: string, agentName: string): Promise<void>;
  onReportAndExit(report: SubmittedAgentReport): Promise<AgentReportSubmissionResult>;
}

function requireCurrentSession(options: Pick<AgentCommunicationToolsOptions, "getTeamName">): string {
  const teamName = options.getTeamName();
  if (!teamName) throw new Error("No active agent session context is available.");
  return teamName;
}

function requireLifecycleRunId(options: Pick<AgentCommunicationToolsOptions, "getLifecycleRunId">): string {
  const runId = options.getLifecycleRunId();
  if (!runId) throw new Error("No lifecycle run identity is available for runtime telemetry.");
  return runId;
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
        await messaging.sendPlainMessageIfRunning(teamName, options.agentName, recipient, params.content, params.summary || "Message");
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
        const unreadOnly = params.unread_only !== false;
        const msgs = await messaging.readInbox(teamName, options.agentName, unreadOnly, markAsRead);
        if (markAsRead) {
          await runtime.writeRuntimeStatus(teamName, options.agentName, requireLifecycleRunId(options), {
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

  const reportAndExitTool = {
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Submit the complete final report to the lead and finish this nested agent run.",
    parameters: Type.Object({
      content: Type.String({ description: "Complete final report to send to the lead; do not replace required output with a summary." }),
      summary: Type.Optional(Type.String({ description: "Short report summary." })),
    }),
    async execute(_toolCallId: string, params: SubmittedAgentReport) {
      const teamName = requireCurrentSession(options);
      const result = await options.onReportAndExit({ content: params.content, summary: params.summary });
      const text = result.accepted
        ? "Final report accepted. Finish immediately; the outer runner will release claims and stop this nested session."
        : "A final report was already accepted for this run. This duplicate was ignored; finish immediately.";
      return {
        content: [{ type: "text", text }],
        details: {
          session: teamName,
          accepted: result.accepted,
          ...(result.cancelledDeliveries === undefined ? {} : {
            cancelledDeliveries: result.cancelledDeliveries,
            deliveryOutcome: result.deliveryOutcome,
          }),
        },
      };
    },
  };

  if (options.role !== "write") return [...communicationTools, reportAndExitTool];

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

  return [...communicationTools, ...fileClaimTools, reportAndExitTool];
}
