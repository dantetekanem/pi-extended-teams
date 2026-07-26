import fs from "node:fs";
import type { AgentReportSource } from "../runtime/types";
import { getLastAssistantText } from "../ui/renderers";
import type { SubmittedAgentReport } from "../tools/agent-communication-tools";

export const EMPTY_REPORT_RECOVERY_PROMPT = [
  "Your previous turn ended without a usable final report.",
  "Do not perform more investigation or edits.",
  "Using only the evidence already gathered in this session, call report_and_exit now with the complete non-empty deliverable requested by the original assignment.",
  "If the assignment could not be completed, call report_and_exit with a non-empty blocker or failure report explaining why.",
].join(" ");

export interface ResolvedReadAgentReport {
  report?: string;
  summary?: string;
  source?: AgentReportSource;
  terminalFailure?: string;
  recoveryReason?: string;
}

export interface PersistedReadAgentMessages {
  messages: any[];
  error?: string;
}

export class ReadAgentReportUnavailableError extends Error {
  readonly reportSource = "irrecoverable-empty" as const;

  constructor(
    message: string,
    readonly recoveryAttempted: boolean,
    readonly recoverySessionId?: string,
    readonly recoverySessionFile?: string,
  ) {
    super(message);
    this.name = "ReadAgentReportUnavailableError";
  }
}

export function nonEmptyReportText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function getAcceptedReportToolSubmission(messages: any[]): SubmittedAgentReport | undefined {
  const acceptedToolCallIds = new Set<string>();
  for (const message of messages || []) {
    if (
      message?.role === "toolResult"
      && message.toolName === "report_and_exit"
      && message.details?.accepted === true
      && typeof message.toolCallId === "string"
    ) {
      acceptedToolCallIds.add(message.toolCallId);
    }
  }
  if (acceptedToolCallIds.size === 0) return undefined;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
      const part = message.content[partIndex];
      if (
        part?.type !== "toolCall"
        || part.name !== "report_and_exit"
        || !acceptedToolCallIds.has(part.id)
      ) continue;
      const content = nonEmptyReportText(part.arguments?.content);
      if (!content) continue;
      return {
        content,
        summary: nonEmptyReportText(part.arguments?.summary),
      };
    }
  }
  return undefined;
}

function getLastAssistantMessage(messages: any[]): any | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") return messages[index];
  }
  return undefined;
}

function terminalAssistantState(messages: any[]): { failure?: string; recoveryReason?: string } {
  const message = getLastAssistantMessage(messages);
  if (!message) return {};
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage = nonEmptyReportText(message.errorMessage);
  if (stopReason === "error" || stopReason === "aborted") {
    return {
      failure: `The final assistant response ended with stopReason=${stopReason}${errorMessage ? `: ${errorMessage}` : "."}`,
    };
  }
  if (stopReason === "length") {
    return { recoveryReason: "The final assistant response reached its output limit before producing a usable report." };
  }
  return {};
}

export function persistedSessionMessages(
  SessionManager: any,
  sessionFile: string | undefined,
): PersistedReadAgentMessages {
  if (!sessionFile || !fs.existsSync(sessionFile)) return { messages: [] };
  try {
    const entries = SessionManager.open(sessionFile).getEntries();
    return {
      messages: entries
        .filter((entry: any) => entry?.type === "message" && entry.message)
        .map((entry: any) => entry.message),
    };
  } catch (error) {
    return { messages: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function resolveReadAgentReport(
  submittedFinalReport: SubmittedAgentReport | undefined,
  immediateMessages: any[],
  persistedMessages: any[],
): ResolvedReadAgentReport {
  const submittedContent = nonEmptyReportText(submittedFinalReport?.content);
  if (submittedContent) {
    return {
      report: submittedContent,
      summary: nonEmptyReportText(submittedFinalReport?.summary),
      source: "report_and_exit",
    };
  }

  const immediateToolReport = getAcceptedReportToolSubmission(immediateMessages);
  if (immediateToolReport) {
    return { report: immediateToolReport.content, summary: immediateToolReport.summary, source: "report_and_exit" };
  }
  const persistedToolReport = getAcceptedReportToolSubmission(persistedMessages);
  if (persistedToolReport) {
    return {
      report: persistedToolReport.content,
      summary: persistedToolReport.summary,
      source: "persisted-report_and_exit",
    };
  }

  const terminal = terminalAssistantState(immediateMessages.length > 0 ? immediateMessages : persistedMessages);
  if (terminal.failure) return { terminalFailure: terminal.failure };
  if (terminal.recoveryReason) return { recoveryReason: terminal.recoveryReason };

  const immediateText = getLastAssistantText(immediateMessages);
  if (immediateText) return { report: immediateText, source: "assistant-text" };
  const persistedText = getLastAssistantText(persistedMessages);
  if (persistedText) return { report: persistedText, source: "persisted-assistant-text" };
  return {};
}

export function readAgentRecoveryReference(
  teamName: string,
  agentName: string,
  runId: string,
  sessionManager: any,
): { sessionId?: string; sessionFile?: string; durableFile: boolean; pointer: string; guidance: string } {
  const sessionId = nonEmptyReportText(sessionManager?.getSessionId?.());
  const sessionFile = nonEmptyReportText(sessionManager?.getSessionFile?.());
  const durableFile = !!sessionFile && fs.existsSync(sessionFile);
  const pointer = [
    "pi-child-session/v1",
    `team=${JSON.stringify(teamName)}`,
    `agent=${JSON.stringify(agentName)}`,
    `lifecycleRunId=${JSON.stringify(runId)}`,
    `sessionId=${JSON.stringify(sessionId ?? "unavailable")}`,
    `sessionFile=${JSON.stringify(sessionFile ?? "unavailable")}`,
    `durableFile=${durableFile}`,
  ].join(" ");
  const guidance = durableFile
    ? `Retrieve the child transcript with the read tool at ${JSON.stringify(sessionFile)} or open it with SessionManager.open(${JSON.stringify(sessionFile)}). Inspect newest message entries for an accepted report_and_exit call and assistant text.`
    : "No child JSONL file was materialized; use the team, agent, lifecycle run, and session identifiers above to correlate runtime and report-event diagnostics.";
  return { sessionId, sessionFile, durableFile, pointer, guidance };
}
