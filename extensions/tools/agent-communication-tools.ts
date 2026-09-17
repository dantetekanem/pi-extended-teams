import { Type } from "@sinclair/typebox";
import { requireLeadRecipient } from "./spawned-agent-policy";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import { formatInboxMessagesForModel, sanitizePlainTuiLine } from "../ui/renderers";
import { createFileClaimTools } from "./file-claim-tools";
import { normalizeReportedTaskDetails, ReportedTaskDetailsSchema, type ReportedTaskDetails, type ReportResult } from "../../src/results/report-result";
import type { RepairRequest } from "../../src/results/verification-controller";

export interface SubmittedAgentReport extends ReportedTaskDetails {
  content: string;
  summary?: string;
}

export type AgentReportSubmissionResult = {
  verification?: ReportResult["verification"];
  cancelledDeliveries?: number;
  deliveryOutcome?: "cancelled" | "none";
} & ({ accepted: boolean; repairRequest?: never } | { accepted: false; repairRequest: RepairRequest });

export function formatRepairRequest(request: RepairRequest): string {
  return [
    `Final report not accepted. Repair attempt ${request.attempt} is reserved (${request.id}).`,
    "Use the observed failures below to repair only your assigned scope. Do not add checks or broaden side effects. If you cannot repair safely, report blocked or failed. Submit a new complete report when done; do not exit yet.",
    ...request.checks.map(check => `${check.assignment.name}: ${check.state}; exit ${check.exitCode ?? "unknown"}; full log: ${check.logPath}${check.error ? `; ${check.error}` : ""}`),
  ].join("\n");
}

export interface AgentCommunicationToolsOptions {
  isTeammate: boolean;
  agentName: string;
  role: "read" | "write";
  getTeamName(): string | null | undefined;
  getLifecycleRunId(): string | undefined;
  authorizeWriteMember(teamName: string, agentName: string): Promise<void>;
  onProgress?(status: string, updatedAt: number): void;
  repairEnabled?: boolean;
  onReportAndExit(report: SubmittedAgentReport, signal?: AbortSignal, submissionId?: string): Promise<AgentReportSubmissionResult>;
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

function normalizeProgressStatus(value: unknown): string {
  if (typeof value !== "string") throw new Error("status must be a string.");
  const status = sanitizePlainTuiLine(value).replace(/\s+/g, " ").trim();
  if (!status) throw new Error("status must not be empty.");
  if (status.length > 120) throw new Error("status must be at most 120 characters.");
  return status;
}

function normalizeFinalReportContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("Final report content must be a string.");
  const content = value.trim();
  if (!content) throw new Error("Final report content must not be empty.");
  return content;
}

export function createReportProgressTool(options: Pick<AgentCommunicationToolsOptions, "isTeammate" | "agentName" | "getTeamName" | "getLifecycleRunId" | "onProgress">): any {
  return {
    name: "report_progress",
    label: "Report Progress",
    description: "Update this agent's latest concise progress phrase without messaging or waking the lead.",
    parameters: Type.Object({
      status: Type.String({ minLength: 1, maxLength: 120, description: "Free-form progress phrase; normalized to one non-empty line (maximum 120 characters)." }),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!options.isTeammate) throw new Error("report_progress is only available to spawned agents.");
      const teamName = requireCurrentSession(options);
      const status = normalizeProgressStatus(params.status);
      const updatedAt = Date.now();
      options.onProgress?.(status, updatedAt);
      try {
        await runtime.writeRuntimeStatus(teamName, options.agentName, requireLifecycleRunId(options), {
          latestProgress: status,
          progressUpdatedAt: updatedAt,
        });
      } catch (error) {
        if (!runtime.isRuntimeStatusWriteRejectedError(error)) throw error;
        return {
          content: [{ type: "text", text: `Progress update skipped: ${status}` }],
          details: { session: teamName, status, updatedAt, updated: false, reason: "lifecycle-closed" },
        };
      }
      return {
        content: [{ type: "text", text: `Progress updated: ${status}` }],
        details: { session: teamName, status, updatedAt, updated: true },
      };
    },
  };
}

export function createAgentCommunicationTools(options: AgentCommunicationToolsOptions): any[] {
  const communicationTools = [
    {
      name: "send_message",
      label: "Send Message",
      description: "Send a direct message in the current Pi session. Spawned agents may message only team-lead.",
      parameters: Type.Object({
        recipient: Type.Optional(Type.String({ description: "Recipient agent name. Defaults to team-lead for spawned agents." })),
        content: Type.String(),
        summary: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireCurrentSession(options);
        const recipient = params.recipient || (options.isTeammate ? "team-lead" : undefined);
        if (!recipient) throw new Error("recipient is required when the lead sends a message.");
        if (options.isTeammate) requireLeadRecipient(recipient);
        await messaging.sendPlainMessageIfRunning(teamName, options.agentName, recipient, params.content, params.summary || "Message");
        return { content: [{ type: "text", text: `Message sent to ${recipient}.` }], details: { session: teamName, recipient } };
      },
    },
    createReportProgressTool(options),
    {
      name: "read_inbox",
      label: "Read Inbox",
      description: "Read this agent's inbox with current sender message-admission status. Status is a snapshot, not proof of process liveness; do not send to unavailable senders.",
      parameters: Type.Object({
        unread_only: Type.Optional(Type.Boolean({ default: true })),
        mark_as_read: Type.Optional(Type.Boolean({ default: true, description: "Set false to peek without marking messages read." })),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = requireCurrentSession(options);
        const markAsRead = params.mark_as_read !== false;
        const unreadOnly = params.unread_only !== false;
        const msgs = await messaging.readInboxWithSenderStatus(teamName, options.agentName, unreadOnly, markAsRead);
        const lifecycleRunId = options.getLifecycleRunId();
        // Do not fail after read flags are persisted; telemetry is best-effort.
        if (markAsRead && lifecycleRunId) {
          await runtime.writeRuntimeStatus(teamName, options.agentName, lifecycleRunId, {
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
    description: options.repairEnabled
      ? "Submit the complete report for verification. If repair is requested, stay in this run and follow the returned feedback; finish only after acceptance."
      : "Submit the complete final report to the lead and finish this nested agent run.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, description: "Complete non-empty final report to send to the lead; do not replace required output with a summary." }),
      summary: Type.Optional(Type.String({ description: "Short report summary." })),
      ...ReportedTaskDetailsSchema.properties,
    }),
    async execute(_toolCallId: string, params: SubmittedAgentReport, signal?: AbortSignal) {
      const teamName = requireCurrentSession(options);
      const content = normalizeFinalReportContent(params.content);
      const summary = typeof params.summary === "string" && params.summary.trim() ? params.summary.trim() : undefined;
      const result = await options.onReportAndExit({ content, summary, ...normalizeReportedTaskDetails(params) }, signal, _toolCallId);
      const text = result.repairRequest ? formatRepairRequest(result.repairRequest) : result.accepted
        ? "Final report accepted. Finish immediately; the outer runner will release claims and stop this nested session."
        : "A final report was already accepted for this run. This duplicate was ignored; finish immediately.";
      return {
        content: [{ type: "text", text }],
        details: {
          session: teamName,
          accepted: result.accepted,
          ...(result.verification ? { verification: result.verification } : {}),
          ...(result.repairRequest ? { repairRequest: result.repairRequest } : {}),
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
