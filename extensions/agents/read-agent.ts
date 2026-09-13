import type { AgentSession } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildPiCommand, getPiLaunchCommand, shellQuote } from "../internal/pi-command";
import { herdrCommand } from "../runtime/herdr";
import * as runtime from "../../src/utils/runtime";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as reportEvents from "../../src/utils/report-events";
import { checkpointReference, preflightReportCheckpoint, saveReportCheckpoint } from "../../src/results/checkpoint-report";
import type { Member, TeamReportEvent } from "../../src/utils/models";
import { deliverCompletionGroupReport } from "../../src/results/completion-group-delivery";
import { createReportResult, effectiveTaskOutcome, normalizeReportedTaskDetails, type ReportResult, type ReportedTaskDetails } from "../../src/results/report-result";
import { assignedCheckIds, normalizeCheckPolicy, type CheckDefinition } from "../../src/results/check-policy";
import { normalizeRepairPolicy, type RepairPolicy } from "../../src/results/repair-policy";
import { VerificationController, type VerificationDecision } from "../../src/results/verification-controller";
import type { CheckRunnerOptions } from "../../src/results/check-runner";
import { loadNativeCheckOperations } from "../internal/pi-check-operations";
import type { AgentReportSource, CompletedAgentReport, RunningReadAgent } from "../runtime/types";
import { extractTextParts, sanitizeTuiLine } from "../ui/renderers";
import { createAgentCommunicationTools, formatRepairRequest, type SubmittedAgentReport } from "../tools/agent-communication-tools";
import { requireWriteAgentTeam } from "../team/roster";
import { isPiPromptPlanningMember, shouldSuppressLeadReportInjection } from "../../src/utils/workflow-metadata";
import { canonicalPersistedModelSlot, loadSettings, requireFavoriteModelLevel } from "../../src/utils/settings";
import { parseQualifiedModel } from "../../src/utils/model-resolution";
import { closePersistedRecipient } from "../team/recipient-closure";
import { generateExtensionInstanceId, generateLifecycleRunId, withLifecycleTombstoneLock } from "../../src/utils/lifecycle-tombstone";
import { createLifecycleRuntime, type ShutdownTeammateOptions } from "../team/lifecycle";
import { recordedSessionCost, type AgentCostSnapshot, type CostOutcome, type CostRun } from "../team/session-cost";
import {
  createSpawnResourcePlan,
  parentProjectTrustForSpawn,
  type SpawnResourcePlan,
} from "../resources/spawn-resource-plan";
import { loadPiRuntimeApi } from "../internal/pi-runtime-api";
import { preparePrivateAgentSessionDirectory } from "../internal/agent-session-files";
import { isEligibleNestedReadParent, NESTED_DELEGATION_TOOL_NAMES } from "../runtime/nested-read-agents";
import { CHILD_AGENT_LIFECYCLE_PROBE, type NestedReadAgentToolBinding } from "../tools/team-tools";
import type { ParentRunIdentity, PendingChildController } from "../runtime/pending-child-controller";
import {
  closeReadAgentMessageDelivery,
  enqueueReadAgentMessageDelivery,
  installReadAgentSessionLifecycle,
  ReadAgentDeliveryCancelledError,
  type ReadAgentDeliveryCloseResult,
  type ReadAgentTeardownResult,
} from "./read-agent-session-lifecycle";
import {
  EMPTY_REPORT_RECOVERY_PROMPT,
  ReadAgentReportUnavailableError,
  nonEmptyReportText,
  persistedSessionMessages,
  readAgentRecoveryReference,
  resolveReadAgentReport,
  type PersistedReadAgentMessages,
  type ResolvedReadAgentReport,
} from "./read-agent-report";

export { closeReadAgentMessageDelivery } from "./read-agent-session-lifecycle";

const pendingParentWakeSignals = new WeakMap<RunningReadAgent, () => void>();
const repairCancellationHandlers = new WeakMap<RunningReadAgent, () => Promise<void>>();

interface ReadAgentWakeState {
  generation: number;
  waiters: Set<() => void>;
}

const readAgentWakeStates = new WeakMap<RunningReadAgent, ReadAgentWakeState>();

function readAgentWakeState(agent: RunningReadAgent): ReadAgentWakeState {
  let state = readAgentWakeStates.get(agent);
  if (!state) {
    state = { generation: 0, waiters: new Set() };
    readAgentWakeStates.set(agent, state);
  }
  return state;
}

function readAgentWakeGeneration(agent: RunningReadAgent): number {
  return readAgentWakeState(agent).generation;
}

function signalReadAgentWake(agent: RunningReadAgent): void {
  const state = readAgentWakeState(agent);
  state.generation += 1;
  const waiters = Array.from(state.waiters);
  state.waiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForReadAgentWake(agent: RunningReadAgent, generation: number): Promise<void> {
  const state = readAgentWakeState(agent);
  if (state.generation !== generation) return Promise.resolve();
  return new Promise<void>((resolve) => { state.waiters.add(resolve); });
}

function disposeReadAgentWake(agent: RunningReadAgent): void {
  signalReadAgentWake(agent);
  readAgentWakeStates.delete(agent);
}

export interface RunReadAgentOptions {
  isTeammate: boolean;
  getTeamName(): string | null | undefined;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  ensureReadAgentStatusTicker(): void;
  renderReadAgentStatus(): void;
  rememberCompletedAgentReport(teamName: string, report: CompletedAgentReport): void;
  emitAgentReport(teamName: string, name: string, startedAt: number, tokens: number, report: string, ok: boolean, suppressLeadInjection?: boolean): void;
  emitAgentProgress?(teamName: string, name: string, status: string, updatedAt: number): void;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  shutdownTeammate?(
    teamName: string,
    member: Member,
    options?: ShutdownTeammateOptions
  ): Promise<ReadAgentTeardownResult>;
  agentName?: string;
  renderLeadInboxStatus?(): Promise<void>;
  notifyLeadOfInboxReports?(teamName: string): Promise<void>;
  deliverMessageToActiveAgent?(
    teamName: string,
    recipient: string,
    content: string,
    expectedRecipientRunId?: string
  ): Promise<boolean>;
  createResourcePlan?(input: { cwd: string; projectTrusted: boolean }): SpawnResourcePlan | Promise<SpawnResourcePlan>;
  extensionInstanceId?: string;
  createNestedReadAgentTools?(binding: NestedReadAgentToolBinding): any[];
  nestedChildSnapshot?(binding: NestedReadAgentToolBinding): { running: number; queued: number };
  pendingChildController?: PendingChildController;
  loadCheckOperations?: CheckRunnerOptions["loadOperations"];
  beginCostRun?(rootSessionId: string, teamName: string, lifecycleRunId: string): CostRun;
}

function pushReadAgentEvent(agent: RunningReadAgent, text: string): void {
  agent.recentEvents.push(text);
  agent.recentEvents = agent.recentEvents.slice(-12);
}

function markReadAgentActivity(
  agent: RunningReadAgent,
  text: string,
  status: RunningReadAgent["status"],
  activeToolName?: string
): void {
  agent.status = status;
  agent.lastActivityAt = Date.now();
  agent.activeToolName = activeToolName;
  agent.idleNudgeLevel = undefined;
  pushReadAgentEvent(agent, text);
}

interface ReadAgentOperationOutcome {
  generation: number;
  interrupted: boolean;
}

async function runReadAgentSessionOperation(
  state: RunningReadAgent,
  operation: () => Promise<void>,
): Promise<ReadAgentOperationOutcome> {
  const generation = (state.operationGeneration ?? 0) + 1;
  state.operationGeneration = generation;
  state.activeOperationGeneration = generation;
  state.completedOperationError = undefined;
  let settleOperation!: () => void;
  const operationSettlement = new Promise<void>((resolve) => { settleOperation = resolve; });
  state.activeOperationSettlementPromise = operationSettlement;

  try {
    let failure: unknown;
    try {
      await operation();
    } catch (error) {
      failure = error;
    }

    const interrupted = state.interruptRequestedGeneration === generation;
    if (interrupted || failure || state.stopRequested) await repairCancellationHandlers.get(state)?.();
    if (state.activeOperationGeneration === generation) state.activeOperationGeneration = undefined;
    if (interrupted) state.interruptRequestedGeneration = undefined;
    state.completedOperationGeneration = generation;
    state.completedOperationInterrupted = interrupted;
    state.completedOperationError = interrupted ? undefined : failure;

    if (interrupted) {
      markReadAgentActivity(state, "command interrupted; waiting for lead", "thinking");
      return { generation, interrupted: true };
    }
    if (failure) throw failure;
    return { generation, interrupted: false };
  } finally {
    if (state.activeOperationSettlementPromise === operationSettlement) {
      state.activeOperationSettlementPromise = undefined;
    }
    settleOperation();
  }
}

function refreshReadAgentStats(agent: RunningReadAgent, session: AgentSession, activityAlreadyMarked = false): void {
  const stats = session.getSessionStats();
  const tokensUsed = stats.tokens.total;
  if (tokensUsed !== agent.tokensUsed && !activityAlreadyMarked) {
    agent.lastActivityAt = Date.now();
    agent.idleNudgeLevel = undefined;
  }
  agent.tokensUsed = tokensUsed;
  const contextUsage = stats.contextUsage ?? session.getContextUsage?.();
  agent.contextUsage = tokensUsed > 0
    ? contextUsage
    : runtime.initialContextUsage(contextUsage?.contextWindow);
}

const MAX_ASSISTANT_PROGRESS_SNIPPET_CHARS = 180;
const MAX_ASSISTANT_PROGRESS_TAIL_CHARS = 384;

function clipAssistantProgressText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ASSISTANT_PROGRESS_SNIPPET_CHARS
    ? `…${trimmed.slice(-(MAX_ASSISTANT_PROGRESS_SNIPPET_CHARS - 1))}`
    : trimmed;
}

function assistantProgressSnippetFromRawText(rawText: string): string | undefined {
  return clipAssistantProgressText(sanitizeTuiLine(rawText));
}

function assistantProgressSnippetFromSafeTail(normalizedText: string): string | undefined {
  return clipAssistantProgressText(normalizedText);
}

function normalizeIncrementalAssistantDelta(delta: string): string | null {
  let normalized: string | undefined;
  let segmentStart = 0;
  for (let index = 0; index < delta.length; index++) {
    const code = delta.charCodeAt(index);
    if ((code <= 8) || (code >= 11 && code <= 31) || (code >= 127 && code <= 159)) return null;
    if (code !== 9 && code !== 10) continue;
    normalized = `${normalized || ""}${delta.slice(segmentStart, index)}${code === 9 ? "   " : " "}`;
    segmentStart = index + 1;
  }
  return normalized === undefined ? delta : `${normalized}${delta.slice(segmentStart)}`;
}

function assistantProgressSnippet(message: any): string | undefined {
  if (message?.role !== "assistant") return undefined;
  return assistantProgressSnippetFromRawText(extractTextParts(message.content));
}

function applyAssistantProgressSnippet(agent: RunningReadAgent, snippet: string | undefined, recordEvent: boolean): boolean {
  if (!snippet || snippet === agent.latestAssistantSnippet) return false;
  agent.latestAssistantSnippet = snippet;
  agent.lastActivityAt = Date.now();
  agent.idleNudgeLevel = undefined;
  if (recordEvent) pushReadAgentEvent(agent, `assistant: ${snippet}`);
  return true;
}

function updateAssistantProgress(agent: RunningReadAgent, message: any, recordEvent: boolean): boolean {
  return applyAssistantProgressSnippet(agent, assistantProgressSnippet(message), recordEvent);
}

function resetIncrementalAssistantProgress(agent: RunningReadAgent): void {
  agent.assistantProgressNormalizedTail = "";
  agent.assistantProgressTailTruncated = false;
  agent.assistantProgressContentIndex = undefined;
  agent.assistantProgressNeedsSeparator = false;
  agent.assistantProgressIncrementalUnsafe = false;
}

function updateAssistantProgressFromEvent(agent: RunningReadAgent, event: any): boolean {
  const update = event.assistantMessageEvent;
  if (!update || typeof update.type !== "string") {
    return updateAssistantProgress(agent, event.message, false);
  }

  if (update.type === "text_start") {
    agent.assistantProgressNeedsSeparator = agent.assistantProgressContentIndex !== undefined
      && agent.assistantProgressContentIndex !== update.contentIndex;
    agent.assistantProgressContentIndex = update.contentIndex;
    return false;
  }

  if (update.type !== "text_delta") {
    return update.type === "text_end"
      ? updateAssistantProgress(agent, event.message, false)
      : false;
  }

  const delta = String(update.delta || "");
  if (agent.assistantProgressIncrementalUnsafe) return updateAssistantProgress(agent, event.message, false);
  const normalizedDelta = normalizeIncrementalAssistantDelta(delta);
  if (normalizedDelta === null) {
    agent.assistantProgressIncrementalUnsafe = true;
    return updateAssistantProgress(agent, event.message, false);
  }

  const needsSeparator = agent.assistantProgressNeedsSeparator
    || (agent.assistantProgressContentIndex !== undefined && agent.assistantProgressContentIndex !== update.contentIndex);
  agent.assistantProgressContentIndex = update.contentIndex;
  agent.assistantProgressNeedsSeparator = false;
  let normalizedTail = `${agent.assistantProgressNormalizedTail || ""}${needsSeparator ? " " : ""}${normalizedDelta}`;
  if (normalizedTail.length > MAX_ASSISTANT_PROGRESS_TAIL_CHARS) {
    normalizedTail = normalizedTail.slice(-MAX_ASSISTANT_PROGRESS_TAIL_CHARS);
    agent.assistantProgressTailTruncated = true;
  }
  agent.assistantProgressNormalizedTail = normalizedTail;

  const snippet = assistantProgressSnippetFromSafeTail(normalizedTail);
  if (agent.assistantProgressTailTruncated && (!snippet || snippet.length < MAX_ASSISTANT_PROGRESS_SNIPPET_CHARS)) {
    return updateAssistantProgress(agent, event.message, false);
  }
  return applyAssistantProgressSnippet(agent, snippet, false);
}

export function handleReadAgentSessionEvent(
  state: RunningReadAgent,
  session: AgentSession,
  event: any,
  renderReadAgentStatus: () => void
): void {
  const eventType = event.type;
  if (eventType === "agent_start" || eventType === "turn_start") {
    markReadAgentActivity(state, "thinking", "thinking");
  }
  if (eventType === "message_start" && event.message?.role === "assistant") {
    resetIncrementalAssistantProgress(state);
    markReadAgentActivity(state, "thinking", "thinking");
  }
  let assistantActivityMarked = false;
  if (eventType === "message_update") {
    assistantActivityMarked = updateAssistantProgressFromEvent(state, event);
    if (assistantActivityMarked) {
      state.status = "thinking";
      state.activeToolName = undefined;
    }
  }
  if (eventType === "message_end" && event.message?.role === "assistant") {
    assistantActivityMarked = updateAssistantProgress(state, event.message, true);
    resetIncrementalAssistantProgress(state);
  }
  if (eventType === "tool_execution_start") {
    markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
  }
  if (eventType === "tool_execution_update") {
    markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
  }
  if (eventType === "tool_execution_end") {
    markReadAgentActivity(state, "thinking", "thinking");
  }
  if (eventType === "agent_end") pushReadAgentEvent(state, "agent complete");
  if (eventType === "message_update" || eventType === "message_end" || eventType === "turn_end" || eventType === "agent_end") {
    try {
      refreshReadAgentStats(state, session, assistantActivityMarked);
      renderReadAgentStatus();
    } catch {
      // Ignore stats races while the nested session is shutting down.
    }
  }
}

export async function sendMessageToRunningReadAgent(agent: RunningReadAgent | undefined, content: string): Promise<boolean> {
  if (!agent) return false;
  if (!agent.session || !agent.acceptingMessages || agent.messageDeliveryClosed || agent.stopRequested) {
    throw new Error(`Cannot send message to ${agent.name}: agent is finishing.`);
  }

  const session = agent.session;
  const deliveryResult = enqueueReadAgentMessageDelivery(
    agent,
    agent.name,
    async () => {
      const check = agent.checkOperation;
      if (check || !session.isStreaming) await (agent.activeOperationSettlementPromise ?? check?.settled);
      const pendingInterrupt = agent.operationInterruptPromise;
      if (pendingInterrupt) await pendingInterrupt.catch(() => {});
      if (agent.messageDeliveryClosed || agent.stopRequested) throw new ReadAgentDeliveryCancelledError(agent.name);
      if (session.isStreaming) {
        await session.sendUserMessage(content, { deliverAs: "steer" as const });
        return;
      }
      await runReadAgentSessionOperation(agent, () => session.sendUserMessage(content, undefined));
    }
  );
  signalReadAgentWake(agent);
  pendingParentWakeSignals.get(agent)?.();
  await deliveryResult;
  if (!agent.checkOperation) markReadAgentActivity(agent, "received lead message", "thinking");
  return true;
}

async function hasRecentMessageFrom(
  teamName: string,
  fromName: string,
  toName: string,
  sinceMs: number,
  matches: (message: any) => boolean = () => true
): Promise<boolean> {
  const messages = await messaging.readInbox(teamName, toName, false, false).catch(() => []);
  return messages.some((message: any) => {
    const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
    return message.from === fromName
      && timestamp >= sinceMs - 1000
      && String(message.text || "").trim().length > 0
      && matches(message);
  });
}

function operationMetadataFromMember(member: Member): { operationId?: string; workflowRunId?: string } {
  return {
    operationId: member.metadata?.operationId || member.metadata?.orchestration?.operationId,
    workflowRunId: member.metadata?.workflowRunId || member.metadata?.orchestration?.workflowRunId,
  };
}

function reportPersistenceBlockReason(
  description: string,
  error: unknown,
  recoveryReference: ReturnType<typeof readAgentRecoveryReference>,
): string {
  const persistenceError = error instanceof Error ? error.message : String(error);
  return [
    `${description}: ${persistenceError}`,
    `Recovery pointer: ${recoveryReference.pointer}`,
    recoveryReference.guidance,
  ].join("\n");
}

async function recordReadAgentReportEvent(
  state: RunningReadAgent,
  isCurrent: () => boolean,
  teamName: string,
  member: Member,
  status: "completed" | "failed",
  report: string,
  summary: string,
  startedAt: number,
  tokensUsed: number,
  result: ReportResult,
  costUsd?: number,
  color?: string,
  reportMetadata: Record<string, any> = {}
): Promise<{ persisted: true; event: TeamReportEvent } | { persisted: false; error: unknown }> {
  const operation = operationMetadataFromMember(member);
  const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
  let checkpointOperation: RunningReadAgent["checkpointOperation"];
  let settle = () => {};
  try {
    if (member.checkpointAssignment) {
      if (state.stopRequested || !isCurrent()) throw new Error("Checkpoint publication cancelled: agent run is closing.");
      if (state.checkpointOperation) throw new Error("Checkpoint publication is already active for this run.");
      checkpointOperation = { controller: new AbortController(), settled: new Promise<void>(resolve => { settle = resolve; }) };
      state.checkpointOperation = checkpointOperation;
    }
    const event = await reportEvents.appendTeamReportEvent(teamName, {
      agentName: member.name,
      checkpoint: checkpointReference(teamName, member),
      completionGroup: member.completionGroup,
      role: member.role || "read",
      status,
      result,
      report,
      summary,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      tokensUsed,
      costUsd,
      model: member.model,
      thinking: member.thinking,
      modelSlot,
      color: color || member.color,
      requestedBy: member.requestedBy,
      source: "read-agent",
      operationId: operation.operationId,
      workflowRunId: operation.workflowRunId,
      metadata: {
        ...(member.prompt ? { initialPrompt: member.prompt } : {}),
        ...(modelSlot ? { modelSlot } : {}),
        ...(member.parentLifecycleRunId ? { parentLifecycleRunId: member.parentLifecycleRunId } : {}),
        ...reportMetadata,
      },
    });
    await saveReportCheckpoint(teamName, member, event, checkpointOperation?.controller.signal);
    if (checkpointOperation && (checkpointOperation.controller.signal.aborted || state.stopRequested || !isCurrent())) throw new Error("Checkpoint publication cancelled: agent run is closing.");
    if (event.checkpoint) result.checkpointId = event.checkpoint.id;
    return { persisted: true, event };
  } catch (error) {
    if (member.checkpointAssignment) state.finalizationBlockedReason ||= `Checkpoint publication failed: ${String(error)}`;
    return { persisted: false, error };
  } finally {
    if (checkpointOperation && state.checkpointOperation === checkpointOperation) state.checkpointOperation = undefined;
    settle();
  }
}

async function ensureLeadCompletionMessage(
  teamName: string,
  member: Member,
  startedAt: number,
  report: string,
  summary: string,
  color: string | undefined,
  metadata: Record<string, any>
): Promise<void> {
  const leadHasReport = await hasRecentMessageFrom(teamName, member.name, "team-lead", startedAt);
  if (leadHasReport) return;

  await messaging.sendPlainMessage(
    teamName,
    member.name,
    "team-lead",
    report,
    summary,
    color,
    { metadata }
  );
}

async function ensureReadHelperCompletionMessages(
  teamName: string,
  member: Member,
  startedAt: number,
  runId: string,
  report: string,
  outcome: "completed" | "failed" = "completed",
  color = member.color,
  options: Pick<RunReadAgentOptions, "deliverMessageToActiveAgent" | "notifyLeadOfInboxReports"> = {}
): Promise<void> {
  if (!member.requestedBy) return;

  let requesterReceivedReport = false;
  // Direct session delivery has no inbox sender envelope. Keep identity outside the report body.
  const attributedReport = `Read helper report ${JSON.stringify({ agentName: member.name, runId, runtimeStatus: outcome })}\n\n${report}`;
  try {
    const requester = (await teams.readConfig(teamName)).members.find(item => item.name === member.requestedBy);
    const expectedRequesterRunId = member.parentAgentName === member.requestedBy
      ? member.parentLifecycleRunId : requester?.lifecycleRunId;
    await messaging.sendPlainMessageOnceIfRunning(
      teamName, member.name, member.requestedBy, report,
      outcome === "failed" ? `Read helper ${member.name} failed` : `Read helper ${member.name} report`,
      {
        color,
        operationId: `helper-report:${runId}`,
        expectedRecipientRunId: expectedRequesterRunId,
        metadata: { helperReport: true, helperCompletion: true, runId, outcome, requestedBy: member.requestedBy },
      }
    );
    requesterReceivedReport = true;
    // Durability, not the requester's complete idle model run, gates helper cleanup.
    // Even an already persisted report must wake its exact requester automatically.
    const wake = expectedRequesterRunId
      ? options.deliverMessageToActiveAgent?.(teamName, member.requestedBy, attributedReport, expectedRequesterRunId)
      : options.deliverMessageToActiveAgent?.(teamName, member.requestedBy, attributedReport);
    void wake?.catch(async () => {
      await messaging.sendPlainMessage(teamName, member.name, "team-lead",
        `Direct report delivery to ${member.requestedBy} was interrupted or failed; its model run may still be active. The durable helper report is retained.`,
        `Read helper ${member.name} wake incomplete`, color,
        { metadata: { helperWakeFailed: true, runId, requestedBy: member.requestedBy, expectedRecipientRunId: expectedRequesterRunId } });
      await options.notifyLeadOfInboxReports?.(teamName);
    }).catch(() => { console.warn(`Could not record helper wake outcome for ${member.name} (${runId}).`); });
  } catch {
    requesterReceivedReport = false;
  }

  const leadHasClassifiedNotice = await hasRecentMessageFrom(
    teamName,
    member.name,
    "team-lead",
    startedAt,
    message => message?.metadata?.finalReport === true
      && message?.metadata?.helperCompletion === true
      && message?.metadata?.runId === runId
  );
  if (!leadHasClassifiedNotice) {
    const delivery = requesterReceivedReport
      ? `Report sent to ${member.requestedBy}.`
      : `${member.requestedBy} is no longer running; the report is retained here.`;
    await messaging.sendPlainMessage(
      teamName,
      member.name,
      "team-lead",
      outcome === "failed"
        ? `Read helper ${member.name} failed for ${member.requestedBy}. ${delivery}`
        : `Read helper ${member.name} completed for ${member.requestedBy}. ${delivery}`,
      outcome === "failed" ? `Read helper ${member.name} failed` : `Read helper ${member.name} done`,
      color,
      { metadata: { finalReport: true, helperCompletion: true, runId, outcome, requestedBy: member.requestedBy } }
    );
  }
}

function assertMemberUsesConfiguredLevel(member: Member): void {
  const settings = loadSettings({ projectDir: member.cwd });
  const level = requireFavoriteModelLevel(settings, member.modelSlot);
  const role = member.role || "read";
  if (role !== level.role) {
    throw new Error(`Agent ${member.name} level ${level.slot} resolves to role ${level.role}, not ${role}. Spawn agents by level only.`);
  }
  if (member.model !== level.model || member.thinking !== level.thinking) {
    throw new Error(`Agent ${member.name} must use configured level ${level.slot}; direct model/thinking overrides are not allowed.`);
  }
}

export async function runReadAgentInProcess(
  readTeamName: string,
  member: Member,
  prompt: string,
  ctx: any,
  options: RunReadAgentOptions
): Promise<void> {
  assertMemberUsesConfiguredLevel(member);
  const key = options.readAgentKey(readTeamName, member.name);
  const role = member.role || "read";
  const roleLabel = role === "write" ? "edit-allowed" : "read-only";
  const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  let resolveSessionCreation!: (session: AgentSession | undefined) => void;
  const sessionCreation = new Promise<AgentSession | undefined>((resolve) => {
    resolveSessionCreation = resolve;
  });
  let lifecycleRunId = member.lifecycleRunId ?? generateLifecycleRunId();
  // Admitted runs can publish startup ownership without awaiting the compatibility lookup.
  // writeRuntimeStatus validates their identity under lifecycle/config locks before work starts.
  if (!member.lifecycleRunId && teams.teamExists(readTeamName)) {
    lifecycleRunId = await teams.ensureMemberLifecycleRunId(readTeamName, member.name, lifecycleRunId);
  }
  member.lifecycleRunId = lifecycleRunId;
  const extensionInstanceId = options.extensionInstanceId ?? generateExtensionInstanceId();
  let costRun: CostRun | undefined;
  let costSnapshot: AgentCostSnapshot | undefined;
  let costOutcome: CostOutcome = "cancelled";
  try {
    costRun = options.beginCostRun?.(ctx.sessionManager.getSessionId(), readTeamName, lifecycleRunId);
  } catch { /* Additive telemetry must not prevent an otherwise valid launch. */ }
  const state: RunningReadAgent = {
    runId: lifecycleRunId,
    name: member.name,
    teamName: readTeamName,
    role,
    startedAt: Date.now(),
    tokensUsed: 0,
    contextUsage: runtime.initialContextUsage(),
    status: "starting",
    recentEvents: [],
    lastActivityAt: Date.now(),
    model: member.model,
    thinking: member.thinking,
    modelSlot,
    finished,
    resolveFinished,
    startupState: "pending",
    sessionCreation,
    teardownState: "active",
    onCostSettled: () => costRun?.settle(costSnapshot, costOutcome),
  };
  let sessionCreationSettled = false;
  const settleSessionCreation = (session: AgentSession | undefined): void => {
    if (sessionCreationSettled) return;
    sessionCreationSettled = true;
    state.startupState = session ? "session_created" : "failed";
    resolveSessionCreation(session);
  };
  options.runningReadAgents.set(key, state);
  options.ensureReadAgentStatusTicker();
  // Production injects the shared lifecycle runtime. The fallback keeps direct
  // library/test callers on that same owner instead of duplicating cleanup here.
  const shutdownTeammate = options.shutdownTeammate ?? createLifecycleRuntime({
    isTeammate: options.isTeammate,
    terminal: null,
    runningReadAgents: options.runningReadAgents,
    readAgentKey: options.readAgentKey,
    isCurrentReadAgentRun: options.isCurrentReadAgentRun,
    renderReadAgentStatus: options.renderReadAgentStatus,
    releaseAllClaimsForAgent: options.releaseAllClaimsForAgent,
    drainWriteQueue: async () => {},
    getSessionCwd: () => member.cwd,
    getTeamName: () => readTeamName,
  }).shutdownTeammate;

  let handoffRequested = false;
  let submittedFinalReport: SubmittedAgentReport | undefined;
  let finalReportSubmissionInProgress = false;
  let childSessionManager: any;
  let childLifecycleProbeUnsubscribe = (): void => {};
  let privateSessionDirectory: string | undefined;
  let completedReportPersisted = false;
  let resolvedTaskResult: ReportResult | undefined;
  let assignedChecks: CheckDefinition[] | undefined;
  let repairPolicy: RepairPolicy | undefined;
  const deliveredRepairRequests = new Set<string>();
  let repairCancellation: Promise<void> | undefined;
  const cancelAutomaticRepair = async (): Promise<void> => {
    const result = resolvedTaskResult;
    if (!repairPolicy || result?.repair?.state !== "requested") return;
    repairCancellation ??= (async () => {
      try {
        await new VerificationController({ teamName: readTeamName, result, cwd: member.cwd, checks: assignedChecks, repair: repairPolicy }).cancel();
        result.repair = { ...result.repair!, state: "cancelled", outcome: "blocked" };
      } catch (error) {
        state.finalizationBlockedReason = `Repair cancellation could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
        result.verification.error = state.finalizationBlockedReason;
        closeReadAgentMessageDelivery(state);
        throw error;
      }
    })();
    await repairCancellation;
  };
  const pendingChildController = options.pendingChildController;
  const pendingChildParent: ParentRunIdentity | undefined = isEligibleNestedReadParent(member)
    ? {
        teamName: readTeamName,
        parentName: member.name,
        parentRunId: state.runId,
      }
    : undefined;
  let pendingChildGeneration: number | undefined;
  if (pendingChildController && pendingChildParent) {
    const snapshot = pendingChildController.observeParent(pendingChildParent);
    pendingChildGeneration = snapshot.generation;
    if (snapshot.cancelled) state.stopRequested = true;
    pendingParentWakeSignals.set(state, () => {
      pendingChildController.signalParentChange(pendingChildParent);
    });
  }

  const closeRecipient = async (): Promise<ReadAgentDeliveryCloseResult> => {
    if (pendingChildParent) pendingChildController?.cancelParent(pendingChildParent);
    const deliveryClose = closeReadAgentMessageDelivery(state);
    if (handoffRequested) return deliveryClose;
    if (!state.recipientClosurePromise) {
      state.recipientClosurePromise = closePersistedRecipient(
        readTeamName,
        member.name,
        state.runId,
        { removeOnFailure: true, role, reason: "quit", extensionInstanceId }
      ).then(() => { state.persistedRecipientClosed = true; });
    }
    await state.recipientClosurePromise;
    return deliveryClose;
  };

  const verifyTaskResult = async (reported: ReportedTaskDetails, signal?: AbortSignal, submissionId?: string): Promise<VerificationDecision> => {
    if (state.checkOperation) throw new Error("Check verification is already active for this run.");
    if (assignedChecks?.length && (state.stopRequested || state.messageDeliveryClosed || state.finalizationBlockedReason || !options.isCurrentReadAgentRun(key, state))) {
      throw new Error("Check verification cancelled: agent run is closing.");
    }
    const result = createReportResult(readTeamName, member.name, state.runId, reported);
    if (resolvedTaskResult?.repair) Object.assign(result, { verification: resolvedTaskResult.verification, repair: resolvedTaskResult.repair });
    resolvedTaskResult = result;
    if (!assignedChecks?.length) return { result, checks: [] };
    let decision: VerificationDecision = { result, checks: [] };
    const verificationController = new VerificationController({
      teamName: readTeamName, result, cwd: member.cwd, checks: assignedChecks, repair: repairPolicy,
    });
    result.verification = { state: "pending", checkIds: assignedCheckIds(result, assignedChecks) };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let settle!: () => void;
    const operation = { controller, settled: new Promise<void>(resolve => { settle = resolve; }) };
    state.checkOperation = operation;
    markReadAgentActivity(state, "running assigned checks", "working", "assigned-check");
    options.renderReadAgentStatus();
    try {
      try {
        decision = await verificationController.verify(submissionId ?? "", {
          loadOperations: options.loadCheckOperations ?? loadNativeCheckOperations,
          signal: controller.signal,
        });
        Object.assign(result, decision.result);
        decision.result = result;
      } catch (error) {
        state.finalizationBlockedReason = `Assigned check evidence could not be persisted: ${error instanceof Error ? error.message : String(error)}`;
        result.verification.error = state.finalizationBlockedReason;
        const repair = verificationController.pendingRepair(error);
        if (repair) result.repair = repair;
        throw error;
      }
      if (result.verification.state === "pending") {
        state.finalizationBlockedReason = "Assigned checks have an unresolved execution claim; inspect the durable journal before finalizing this run.";
        throw new Error(state.finalizationBlockedReason);
      }
      if (controller.signal.aborted || state.stopRequested || !options.isCurrentReadAgentRun(key, state)) {
        await cancelAutomaticRepair();
        throw new Error("Assigned check verification was cancelled.");
      }
      return decision;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (state.checkOperation === operation) state.checkOperation = undefined;
      if (controller.signal.aborted && !state.messageDeliveryClosed && !state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
        state.acceptingMessages = true;
      }
      settle();
    }
  };

  const deliverGroupedReport = async (event: TeamReportEvent, leadReport: string): Promise<void> => {
    const planning = isPiPromptPlanningMember(member);
    const suppressed = shouldSuppressLeadReportInjection(member);
    const emitsEvent = planning || (!suppressed && !options.isTeammate
      && (options.getTeamName() === readTeamName || readTeamName.startsWith("prompt-build-")));
    const grouped = await deliverCompletionGroupReport(event, () => {
      if (emitsEvent) options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed,
        planning ? event.report : leadReport, event.status === "completed", true);
    });
    if (!grouped) throw new Error("Grouped report provenance is unavailable.");
    if (!suppressed && !readTeamName.startsWith("prompt-build-")) {
      await options.renderLeadInboxStatus?.().catch(() => {});
      await options.notifyLeadOfInboxReports?.(readTeamName).catch(() => {});
    }
  };

  const deliverCompletion = async (
    resolution: ResolvedReadAgentReport,
    completionSummary: string,
    recoveryAttempted: boolean,
    recoveryReference: ReturnType<typeof readAgentRecoveryReference>,
  ): Promise<void> => {
    const session = state.session;
    if (!session) throw new Error(`Agent ${member.name} completed without a nested session.`);
    const report = resolution.report!;
    const result = resolvedTaskResult ?? createReportResult(readTeamName, member.name, state.runId, resolution);
    resolvedTaskResult = result;
    const checkpoint = checkpointReference(readTeamName, member);
    if (checkpoint) result.checkpointId = checkpoint.id;
    const leadReport = (assignedChecks?.length
      ? `${report}\n\nHarness verification: ${result.verification.state}; lead acceptance: ${result.acceptance.state}${result.repair ? `; repair: ${result.repair.state}; effective task: ${effectiveTaskOutcome(result) ?? "unspecified"}` : ""}. Evidence: ${result.reportId}.`
      : report) + (checkpoint ? `\n\nCheckpoint reference: ${checkpoint.id}.` : "");
    const completionStats = session.getSessionStats();
    // Private child transcripts are deleted after teardown; never publish pointers
    // that would outlive a successful run's recovery artifact.
    const includeRecoveryReference = !privateSessionDirectory
      && (recoveryAttempted || resolution.source?.startsWith("persisted-"));
    const reportMetadata = {
      reportSource: resolution.source,
      recoveryAttempted,
      ...(includeRecoveryReference && recoveryReference.sessionId
        ? { recoverySessionId: recoveryReference.sessionId }
        : {}),
      ...(includeRecoveryReference && recoveryReference.sessionFile
        ? { recoverySessionFile: recoveryReference.sessionFile }
        : {}),
    };
    options.rememberCompletedAgentReport(readTeamName, {
      name: member.name,
      role,
      status: "completed",
      result,
      report,
      summary: completionSummary,
      completedAt: Date.now(),
      startedAt: state.startedAt,
      elapsedMs: Date.now() - state.startedAt,
      tokensUsed: state.tokensUsed,
      costUsd: completionStats.cost,
      model: member.model,
      thinking: member.thinking,
      modelSlot,
      color: member.color,
      requestedBy: member.requestedBy,
      initialPrompt: member.prompt || prompt,
      ...reportMetadata,
      source: "read-agent",
    });
    const completionMetadata = {
      finalReport: true,
      startedAt: state.startedAt,
      elapsedMs: Date.now() - state.startedAt,
      tokensUsed: state.tokensUsed,
      costUsd: completionStats.cost,
      model: member.model,
      thinking: member.thinking,
      modelSlot,
      initialPrompt: member.prompt || prompt,
      ...reportMetadata,
    };
    const reportEventPersistence = await recordReadAgentReportEvent(
      state,
      () => options.isCurrentReadAgentRun(key, state),
      readTeamName,
      member,
      "completed",
      report,
      completionSummary,
      state.startedAt,
      state.tokensUsed,
      result,
      completionStats.cost,
      undefined,
      reportMetadata,
    );
    if (!reportEventPersistence.persisted) {
      state.finalizationBlockedReason = reportPersistenceBlockReason(
        "Could not durably persist the completed read-agent report",
        reportEventPersistence.error,
        recoveryReference,
      );
      throw new Error(state.finalizationBlockedReason);
    }
    if (checkpoint && (state.stopRequested || !options.isCurrentReadAgentRun(key, state))) return;
    completedReportPersisted = true;
    // The lifecycle finalizer consumes this flag only after session disposal and
    // successful lifecycle finalization, so every successful private run is removed.
    if (privateSessionDirectory) {
      state.cleanupPrivateSessionOnFinalize = true;
    }
    const suppressLeadReportInjection = shouldSuppressLeadReportInjection(member);
    if (member.completionGroup && !member.requestedBy) {
      await deliverGroupedReport(reportEventPersistence.event, leadReport);
    } else if (member.requestedBy) {
      await ensureReadHelperCompletionMessages(
        readTeamName,
        member,
        state.startedAt,
        state.runId,
        report,
        "completed",
        member.color,
        options
      );
      await options.renderLeadInboxStatus?.().catch(() => {});
      await options.notifyLeadOfInboxReports?.(readTeamName).catch(() => {});
    } else if (suppressLeadReportInjection) {
      if (isPiPromptPlanningMember(member)) {
        options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed, report, true, true);
      }
      // Workflow orchestrators consume full reports from TeamReportEvent storage.
      // Pi Prompt consumes its writer report through the private event without a lead turn.
    } else if (!options.isTeammate && (options.getTeamName() === readTeamName || readTeamName.startsWith("prompt-build-"))) {
      options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed, leadReport, true);
    } else {
      await ensureLeadCompletionMessage(readTeamName, member, state.startedAt, leadReport, completionSummary, member.color, completionMetadata);
    }
  };

  try {
    assignedChecks = normalizeCheckPolicy(member.assignedChecks);
    repairPolicy = normalizeRepairPolicy(member.repairPolicy);
    if (repairPolicy && !assignedChecks?.length) throw new Error("Repair policy requires explicitly assigned checks.");
    if (repairPolicy) repairCancellationHandlers.set(state, cancelAutomaticRepair);
    if (pendingChildParent && !pendingChildController) {
      throw new Error(`Eligible nested read parent ${member.name} requires a pending child controller.`);
    }
    const parsedModel = parseQualifiedModel(member.model || "");
    const provider = parsedModel?.provider;
    const modelId = parsedModel?.model;
    const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
    if (!model) {
      throw new Error(`Read agent model "${member.model}" is not available.`);
    }

    await runtime.writeRuntimeStatus(readTeamName, member.name, state.runId, {
      pid: process.pid,
      startedAt: state.startedAt,
      lastHeartbeatAt: Date.now(),
      ready: true,
      lastError: undefined,
    });

    if (!state.stopRequested) {
      state.heartbeatTimer = setInterval(async () => {
        try {
          await runtime.writeRuntimeStatus(readTeamName, member.name, state.runId, {
            lastHeartbeatAt: Date.now(),
          });
        } catch {
          // Ignore heartbeat races during shutdown.
        }
      }, 5000);
    }

    const {
      createAgentSession,
      createEventBus,
      DefaultResourceLoader,
      getAgentDir,
      SessionManager,
      SettingsManager,
    } = await loadPiRuntimeApi();
    const agentDir = getAgentDir();
    const projectTrusted = parentProjectTrustForSpawn(ctx, member.cwd);
    const resourcePlan = await (options.createResourcePlan ?? createSpawnResourcePlan)({
      cwd: member.cwd,
      projectTrusted,
    });
    const createSettingsManager = SettingsManager.create as unknown as (
      cwd: string,
      agentDir: string,
      options: { projectTrusted: boolean },
    ) => any;
    const childSettingsManager = createSettingsManager(member.cwd, agentDir, {
      projectTrusted: resourcePlan.trust.projectTrusted,
    });
    const nestedReadBinding = isEligibleNestedReadParent(member)
      ? {
          teamName: readTeamName,
          parent: member,
          parentRunId: state.runId,
          outerCtx: ctx,
        }
      : undefined;
    const nestedReadAgentTools = nestedReadBinding
      ? options.createNestedReadAgentTools?.(nestedReadBinding) ?? []
      : [];
    const nestedReadDelegationEnabled = nestedReadAgentTools.length > 0;
    const childEventBus = createEventBus();
    const loader = new DefaultResourceLoader({
      eventBus: childEventBus,
      cwd: member.cwd,
      agentDir,
      settingsManager: childSettingsManager,
      noExtensions: true,
      additionalExtensionPaths: [...resourcePlan.extensionPaths],
      noSkills: false,
      appendSystemPrompt: [
        `You are ${roleLabel} agent '${member.name}' in Pi session '${readTeamName}', running in-process so the lead can follow and control you from Pi.`,
        role === "write"
          ? "You may use edit/write tools for the assigned scope only. Keep changes small, avoid unrelated cleanup, and report every file changed. Do not install or remove packages, start long-running services, commit, push, deploy, or make destructive changes unless the lead explicitly assigned that side effect."
          : "You have the full toolset and may run any read-only shell command you need to investigate — git status/log/diff/show, grep/rg, ls, cat, running tests or builds, etc.",
        role === "write"
          ? "Use read/bash/edit/write as needed for the assignment. Prefer precise edits. Stop and report if you need broader product or architecture approval."
          : "Even though the edit/write tools are available, do not use them: do not edit or write files, install or remove packages, start long-running services, commit, push, deploy, or make any other mutating or destructive change. Investigate and report; if a change is needed, recommend it to the lead instead of applying it.",
        "Use send_message for direct communication and read_inbox only when you were told a reply is waiting. Do not coordinate a peer-agent society; the lead controls orchestration.",
        "Progress reporting is required, not optional UI polish. Call report_progress before your first work tool with a concise phrase describing what you are starting. Call it again whenever you change phase or evidence source, hit a blocker, or begin synthesis; never make more than 3 work-tool calls without a fresh progress update. Use a new phrase describing what you are doing now. It updates the activity widget without messaging or waking the lead; do not use it as a heartbeat.",
        ...(member.requestedBy
          ? [`You are a depth-1 read helper requested by '${member.requestedBy}'. Your report_and_exit deliverable goes to that requesting writer; the lead receives only a classified completion notice. You cannot delegate.`]
          : nestedReadDelegationEnabled
            ? [
                "This opted-in depth-0 write-feature/write-critical run may use restricted spawn_agent or spawn_swarm_agents for depth-1 read-only helpers. Choose any canonical read-* tier and any helper count, subject to the team's global read capacity and queue. Children report to you and cannot delegate.",
                "Use spawn_agent with only name (optional), prompt, and model_slot. Use spawn_swarm_agents with optional defaults.model_slot plus agents using only name (optional), prompt, and model_slot.",
                "When waiting on children, end your turn without calling report_and_exit; each child report resumes you automatically. One get_agent_status snapshot is allowed when current status is needed, but never call it repeatedly.",
                "Do not request write tiers, cwd/team overrides, metadata, replacement of an active/queued name, or delegation outside your assigned scope.",
              ]
            : ["You cannot spawn or create other agents. If another agent is needed, use send_message to ask team-lead; only the lead decides and performs the spawn."]),
        "NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.",
        repairPolicy
          ? `Use report_and_exit with the complete deliverable in content. The lead authorized at most ${repairPolicy.maxAttempts} additional repair attempts for assigned checks. If the tool requests repair, stay active, inspect its observed evidence and repair only within your role and assigned scope. Report blocked or failed if you cannot continue safely. Stop only after the report is accepted; never replace the deliverable with a summary.`
          : "When finished, use report_and_exit with the complete required deliverable in content and only a short label in summary, then stop. Never replace required output with a summary. Do not wait for the lead to kill you — report and exit cleanly.",
      ],
    });
    await loader.reload();

    const communicationTools = createAgentCommunicationTools({
      isTeammate: true,
      agentName: member.name,
      role,
      getTeamName: () => readTeamName,
      getLifecycleRunId: () => state.runId,
      authorizeWriteMember: async (teamName, agentName) => {
        await requireWriteAgentTeam(teamName, true, agentName);
      },
      onProgress: (status, updatedAt) => {
        options.emitAgentProgress?.(readTeamName, member.name, status, updatedAt);
        state.latestProgress = status;
        state.progressUpdatedAt = updatedAt;
        state.lastActivityAt = updatedAt;
        state.idleNudgeLevel = undefined;
        pushReadAgentEvent(state, status);
        options.renderReadAgentStatus();
      },
      repairEnabled: !!repairPolicy,
      onReportAndExit: async (report, signal, submissionId) => {
        const content = nonEmptyReportText(report.content);
        if (!content) throw new Error("Final report content must not be empty.");
        if (submittedFinalReport || finalReportSubmissionInProgress) return { accepted: false };
        finalReportSubmissionInProgress = true;
        try {
          if (member.checkpointAssignment) preflightReportCheckpoint(readTeamName, member, createReportResult(readTeamName, member.name, state.runId, report));
          const decision = await verifyTaskResult(report, signal, submissionId ? `tool:${submissionId}` : undefined);
          if (decision.request) {
            deliveredRepairRequests.add(decision.request.id);
            return { accepted: false, verification: decision.result.verification, repairRequest: decision.request };
          }
          const result = decision.result;
          const deliveryClose = await closeRecipient();
          submittedFinalReport = {
            ...normalizeReportedTaskDetails(report),
            content,
            summary: nonEmptyReportText(report.summary),
          };
          return {
            accepted: true,
            ...(assignedChecks?.length ? { verification: result.verification } : {}),
            cancelledDeliveries: deliveryClose.cancelledDeliveries,
            deliveryOutcome: deliveryClose.cancelledDeliveries > 0 ? "cancelled" : "none",
          };
        } finally {
          finalReportSubmissionInProgress = false;
        }
      },
    });
    const communicationToolNames = communicationTools.map(tool => tool.name);
    const communicationToolNameSet = new Set(communicationToolNames);
    const delegationToolNameSet = new Set<string>(NESTED_DELEGATION_TOOL_NAMES);
    const extensionToolNames = loader.getExtensions().extensions.flatMap(extension => {
      return Array.from(extension.tools.keys()).filter(name => !communicationToolNameSet.has(name) && !delegationToolNameSet.has(name));
    });
    const nestedReadAgentToolNames = nestedReadAgentTools.map(tool => tool.name);
    const activeToolNames = Array.from(new Set([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...extensionToolNames,
      ...communicationToolNames,
      ...nestedReadAgentToolNames,
    ]));

    const agentSettings = loadSettings({ projectDir: member.cwd });
    privateSessionDirectory = agentSettings.agentSessions.showInResume
      ? undefined
      : preparePrivateAgentSessionDirectory(readTeamName, member.name, state.runId);
    childSessionManager = privateSessionDirectory
      ? SessionManager.create(member.cwd, privateSessionDirectory)
      : SessionManager.create(member.cwd);
    try { costSnapshot = { childSessionId: childSessionManager.getSessionId(), costUsd: null }; } catch { /* Unknown provenance. */ }
    if (nestedReadBinding && options.nestedChildSnapshot) {
      const childSessionId = childSessionManager.getSessionId();
      childLifecycleProbeUnsubscribe = childEventBus.on(CHILD_AGENT_LIFECYCLE_PROBE, (payload: any) => {
        if (payload?.sessionId !== childSessionId || typeof payload.respond !== "function") return;
        payload.respond({ sessionId: childSessionId, ...options.nestedChildSnapshot!(nestedReadBinding) });
      });
    }
    const parentModelRuntime: unknown = Reflect.get(ctx.modelRegistry, "runtime");
    const { session } = await createAgentSession({
      cwd: member.cwd,
      model,
      thinkingLevel: member.thinking as any,
      // Pi 0.82 consumes modelRuntime; reuse the parent's runtime so nested
      // sessions retain custom providers and runtime-scoped credentials.
      modelRuntime: parentModelRuntime,
      modelRegistry: ctx.modelRegistry,
      tools: activeToolNames,
      customTools: [...communicationTools, ...nestedReadAgentTools],
      resourceLoader: loader,
      settingsManager: childSettingsManager,
      sessionManager: childSessionManager,
    } as Parameters<typeof createAgentSession>[0] & { modelRuntime?: unknown });

    state.session = session;
    // Current hosts capture this public hook when a prompt starts; legacy hosts
    // retain their existing loop behavior. Never abort from the reporting tool.
    if (session.agent && "shouldStopAfterTurn" in session.agent) {
      const agent = session.agent as typeof session.agent & {
        shouldStopAfterTurn?: (...args: unknown[]) => boolean | Promise<boolean>;
      };
      const previous = agent.shouldStopAfterTurn;
      agent.shouldStopAfterTurn = async (...args) => {
        const stopped = await previous?.(...args);
        return submittedFinalReport !== undefined || stopped === true;
      };
    }
    const sessionLifecycle = installReadAgentSessionLifecycle(session, () => {
      if (handoffRequested) return;
      const own = recordedSessionCost(childSessionManager.getEntries());
      costSnapshot = { childSessionId: childSessionManager.getSessionId(), costUsd: own.complete ? own.usd : null };
    });
    try {
      if (typeof session.bindExtensions === "function") {
        await (session.bindExtensions as (bindings: { mode: "print" }) => Promise<void>)({ mode: "print" });
      }
    } finally {
      // Selected extensions emit session_start while binding. Open the startup gate
      // to teardown only after binding settles so session_shutdown cannot precede start.
      settleSessionCreation(session);
    }
    if (state.stopRequested || !options.isCurrentReadAgentRun(key, state)) {
      if (state.teardownState !== "persistence_failed") await state.teardownPromise;
      return;
    }
    if (process.env.HERDR_ENV === "1" && (member.delegationDepth ?? 0) === 0
      && !member.requestedBy && !member.parentAgentName && !member.allowNestedReadAgents
      && !shouldSuppressLeadReportInjection(member)) {
      let moving: Promise<void> | undefined;
      let paneId: string | undefined;
      let command = "";
      let queued: string[] = [];
      let released = false;
      const release = Promise.all([finished, sessionLifecycle.finalized]).then(() => {
        if (handoffRequested) { state.session = undefined; released = true; }
      });
      void release.catch(() => {});
      const recordPane = (id: string | undefined) => withLifecycleTombstoneLock(readTeamName, member.name, async lock => {
        const current = (await teams.readConfig(readTeamName)).members.find(item => item.name === member.name);
        if (!current || current.lifecycleRunId !== state.runId || current.isActive === false || lock.read().status !== "absent") {
          throw new Error("The agent is no longer available to move.");
        }
        await teams.updateMember(readTeamName, member.name, { herdrPaneId: id, tmuxPaneId: "" });
      });
      const rejectActiveCheck = (): void => {
        if (state.checkOperation) {
          throw new Error("Cannot move agent to Herdr while an assigned check is active. Try again after it settles.");
        }
      };
      state.moveToHerdr = () => moving ??= (async () => {
        if (!options.isCurrentReadAgentRun(key, state) || (!handoffRequested && !state.acceptingMessages)) {
          throw new Error("The agent is already finishing.");
        }
        if (handoffRequested && !released) throw new Error("The current operation is still stopping. Try h after it settles.");
        if (paneId) {
          rejectActiveCheck();
          herdrCommand("pane", "close", paneId);
          await recordPane(undefined);
          paneId = undefined;
        }
        rejectActiveCheck();
        const sessionFile = childSessionManager.getSessionFile();
        if (!sessionFile || !fs.existsSync(sessionFile)) throw new Error("The agent has no saved session yet.");
        if (!handoffRequested) {
          const promptDir = privateSessionDirectory ?? preparePrivateAgentSessionDirectory(readTeamName, member.name, state.runId);
          const promptFile = path.join(promptDir, "herdr-system-prompt.txt");
          fs.writeFileSync(promptFile, session.agent.state.systemPrompt.replace("running in-process so the lead can follow and control you from Pi", "running in a Herdr pane"), { mode: 0o600 });
          const tools = session.agent.state.tools.map(tool => tool.name).join(",");
          const identity = {
            HOME: os.homedir(), PI_CODING_AGENT_DIR: agentDir,
            PI_AGENT_NAME: member.name, PI_TEAM_NAME: readTeamName, PI_LIFECYCLE_RUN_ID: state.runId,
            PI_EXTENDED_TEAMS_HERDR_RESUME: "1",
          };
          const currentModel = session.model ?? model;
          const launch = buildPiCommand(getPiLaunchCommand(), `${currentModel.provider}/${currentModel.id}`,
            session.thinkingLevel ?? member.thinking, resourcePlan.extensionPaths,
            resourcePlan.trust.projectTrusted, resourcePlan.selfExtensionPath);
          command = [
            "env", ...Object.entries(identity).map(([name, value]) => `${name}=${shellQuote(value)}`), launch,
            "--session", shellQuote(sessionFile), "--tools", shellQuote(tools), "--system-prompt", shellQuote(promptFile),
          ].join(" ");
          // Keep fresh-shell input below the PTY line limit without shortening the launch arguments.
          const launchFile = path.join(promptDir, "herdr-launch.sh");
          fs.writeFileSync(launchFile, `exec ${command}\n`, { mode: 0o600 });
          command = `/bin/sh ${shellQuote(launchFile)}`;
        }
        paneId = JSON.parse(herdrCommand("pane", "split", "--current", "--direction", "right", "--cwd", member.cwd, "--focus")).result?.pane?.pane_id;
        if (typeof paneId !== "string" || !paneId) throw new Error("Herdr did not return a pane ID.");
        try {
          if (!handoffRequested) {
            handoffRequested = true;
            try { costRun?.exclude(); } catch { /* Terminal work is outside this total. */ }
            state.stopRequested = true;
            const delivery = closeReadAgentMessageDelivery(state);
            const pending = session.clearQueue();
            queued = [...pending.steering, ...pending.followUp];
            signalReadAgentWake(state);
            const shutdown = await sessionLifecycle.requestShutdown("resume", delivery.rawDeliverySettlement);
            if (shutdown.status !== "settled" || shutdown.abort !== "settled" || shutdown.dispose !== "settled") {
              throw new Error("The current operation has not stopped. Try h after it settles.");
            }
            await release;
          }
          if (queued.length) {
            SessionManager.open(sessionFile).appendMessage({ role: "user", content: queued.join("\n\n"), timestamp: Date.now() });
            queued = [];
          }
          const previousPid = (await runtime.readRuntimeStatus(readTeamName, member.name))?.pid;
          await recordPane(paneId);
          herdrCommand("pane", "run", paneId, command);
          const deadline = Date.now() + 10000;
          for (;;) {
            const status = await runtime.readRuntimeStatus(readTeamName, member.name);
            if (status?.lifecycleRunId === state.runId && status.pid && status.pid !== previousPid && status.pid !== process.pid) break;
            if (Date.now() >= deadline) throw new Error("Pi did not resume. The saved session is retained; h can retry.");
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (options.isCurrentReadAgentRun(key, state)) options.runningReadAgents.delete(key);
          options.renderReadAgentStatus();
        } catch (error) {
          herdrCommand("pane", "close", paneId);
          await recordPane(undefined);
          paneId = undefined;
          throw error;
        }
      })().catch(error => { moving = undefined; throw error; });
    }
    markReadAgentActivity(state, "started", "thinking");
    options.renderReadAgentStatus();

    session.subscribe((event: any) => {
      handleReadAgentSessionEvent(state, session, event, options.renderReadAgentStatus);
    });

    let persistedSnapshot: PersistedReadAgentMessages = { messages: [] };
    let completionResolution: ResolvedReadAgentReport | undefined;
    let recoveryAttempted = false;
    const resolveCurrentReport = (): ResolvedReadAgentReport => {
      persistedSnapshot = persistedSessionMessages(
        SessionManager,
        nonEmptyReportText(childSessionManager.getSessionFile?.()),
      );
      return resolveReadAgentReport(submittedFinalReport, session.messages, persistedSnapshot.messages);
    };
    const unavailableReportError = (reason: string): ReadAgentReportUnavailableError => {
      const reference = readAgentRecoveryReference(readTeamName, member.name, state.runId, childSessionManager);
      const message = [
        reason,
        persistedSnapshot.error ? `The durable child session could not be read: ${persistedSnapshot.error}` : undefined,
        `Recovery pointer: ${reference.pointer}`,
        reference.guidance,
      ].filter(Boolean).join("\n");
      return new ReadAgentReportUnavailableError(
        message,
        recoveryAttempted,
        reference.sessionId,
        reference.sessionFile,
      );
    };

    const waitForPostInterruptOperation = async (
      interruptedGeneration: number,
      initialWakeGeneration: number,
    ): Promise<boolean> => {
      state.operationAwaitingResume = true;
      let observedOperationGeneration = interruptedGeneration;
      let observedWakeGeneration = initialWakeGeneration;
      try {
        while (!state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
          const currentWakeGeneration = readAgentWakeGeneration(state);
          if (currentWakeGeneration === observedWakeGeneration) {
            const wake = waitForReadAgentWake(state, observedWakeGeneration);
            await (state.finished ? Promise.race([wake, state.finished]) : wake);
          }
          observedWakeGeneration = readAgentWakeGeneration(state);
          if (state.stopRequested || !options.isCurrentReadAgentRun(key, state)) return false;

          const deliveryTail = state.messageDeliveryTail;
          if (deliveryTail) await deliveryTail.catch(() => {});
          const completedGeneration = state.completedOperationGeneration ?? 0;
          if (completedGeneration <= observedOperationGeneration) continue;
          observedOperationGeneration = completedGeneration;
          if (state.completedOperationError) throw state.completedOperationError;
          if (state.completedOperationInterrupted) continue;
          return true;
        }
        return false;
      } finally {
        state.operationAwaitingResume = false;
      }
    };

    state.acceptingMessages = true;
    try {
      const initialWakeGeneration = readAgentWakeGeneration(state);
      const initialOperation = await runReadAgentSessionOperation(
        state,
        () => session.prompt(prompt, { source: "extension" as any }),
      );
      refreshReadAgentStats(state, session);
      if (initialOperation.interrupted) {
        const resumed = await waitForPostInterruptOperation(initialOperation.generation, initialWakeGeneration);
        if (!resumed) return;
        refreshReadAgentStats(state, session);
      }
      if (pendingChildController && pendingChildParent) {
        while (!submittedFinalReport && !state.stopRequested) {
          const snapshot = pendingChildController.observeParent(pendingChildParent);
          if (snapshot.cancelled) break;

          let change;
          if (snapshot.generation !== pendingChildGeneration) {
            change = { status: "changed" as const, generation: snapshot.generation };
          } else {
            change = await pendingChildController.waitForChangeOrCancelled(
              pendingChildParent,
              snapshot.generation
            );
          }
          pendingChildGeneration = change.generation;
          if (change.status === "cancelled" || submittedFinalReport || state.stopRequested) break;

          // Every direct delivery and exact child transition advances the parent
          // generation. Drain the current delivery, then observe again because
          // its continuation may accept or settle another child wave.
          const deliveryTail = state.messageDeliveryTail;
          if (deliveryTail) await deliveryTail.catch(() => {});
        }
      } else if (!state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
        completionResolution = resolveCurrentReport();
        if (completionResolution.terminalFailure) {
          throw unavailableReportError(completionResolution.terminalFailure);
        }
        if (!completionResolution.report) {
          recoveryAttempted = true;
          markReadAgentActivity(state, "recovering missing report", "thinking");
          options.renderReadAgentStatus();
          try {
            const recoveryWakeGeneration = readAgentWakeGeneration(state);
            const recoveryOperation = await runReadAgentSessionOperation(
              state,
              () => session.prompt(EMPTY_REPORT_RECOVERY_PROMPT, { source: "extension" as any }),
            );
            refreshReadAgentStats(state, session);
            if (recoveryOperation.interrupted) {
              const resumed = await waitForPostInterruptOperation(
                recoveryOperation.generation,
                recoveryWakeGeneration,
              );
              if (!resumed) return;
              refreshReadAgentStats(state, session);
            }
          } catch (error) {
            throw unavailableReportError(
              `The report-only recovery turn failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          completionResolution = resolveCurrentReport();
          if (completionResolution.terminalFailure) {
            throw unavailableReportError(completionResolution.terminalFailure);
          }
          if (!completionResolution.report) {
            throw unavailableReportError(
              completionResolution.recoveryReason
                ?? "The agent completed a report-only recovery turn without producing any usable final report.",
            );
          }
        }
      }
      while (assignedChecks?.length && !submittedFinalReport && !pendingChildParent
        && !state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
        const wakeGeneration = readAgentWakeGeneration(state);
        // A delivery may have started before checks owned the operation gate.
        // Drain every admitted turn before capturing or verifying its final report.
        let deliveryTail: Promise<void> | undefined;
        do {
          deliveryTail = state.messageDeliveryTail;
          if (deliveryTail) await deliveryTail.catch(() => {});
        } while (deliveryTail !== state.messageDeliveryTail);
        if (state.stopRequested || !options.isCurrentReadAgentRun(key, state)) break;
        completionResolution = resolveCurrentReport();
        if (submittedFinalReport) break;
        if (state.completedOperationError) throw state.completedOperationError;
        if (state.completedOperationInterrupted) {
          if (!await waitForPostInterruptOperation(state.completedOperationGeneration!, wakeGeneration)) return;
          continue;
        }
        if (completionResolution.terminalFailure || !completionResolution.report) {
          throw unavailableReportError(completionResolution.terminalFailure ?? "No usable report is available for verification.");
        }
        const submissionId = `fallback:${state.completedOperationGeneration ?? 0}`;
        let decision: VerificationDecision | undefined;
        const verification = await runReadAgentSessionOperation(state, async () => {
          decision = await verifyTaskResult(completionResolution!, undefined, submissionId);
        });
        if (verification.interrupted) {
          if (!await waitForPostInterruptOperation(verification.generation, wakeGeneration)) return;
        } else {
          let deliveryTail: Promise<void> | undefined;
          do {
            deliveryTail = state.messageDeliveryTail;
            if (deliveryTail) await deliveryTail.catch(() => {});
          } while (deliveryTail !== state.messageDeliveryTail);
          state.acceptingMessages = false;
          const latestGeneration = state.completedOperationGeneration ?? verification.generation;
          if (latestGeneration === verification.generation) {
            const request = decision?.request;
            if (!request || deliveredRepairRequests.has(request.id)) break;
            deliveredRepairRequests.add(request.id);
            if (state.messageDeliveryClosed || state.stopRequested || !options.isCurrentReadAgentRun(key, state)) return;
            state.acceptingMessages = true;
            markReadAgentActivity(state, `repairing assigned checks (attempt ${request.attempt})`, "thinking");
            options.renderReadAgentStatus();
            const repairWake = readAgentWakeGeneration(state);
            const repairOperation = await runReadAgentSessionOperation(state, () => session.prompt(formatRepairRequest(request), { source: "extension" as any }));
            refreshReadAgentStats(state, session);
            if (repairOperation.interrupted && !await waitForPostInterruptOperation(repairOperation.generation, repairWake)) return;
            completionResolution = resolveCurrentReport();
            continue;
          }
          if (state.completedOperationError) throw state.completedOperationError;
          if (state.completedOperationInterrupted) {
            state.acceptingMessages = !state.messageDeliveryClosed && !state.stopRequested && options.isCurrentReadAgentRun(key, state);
            if (!await waitForPostInterruptOperation(latestGeneration, wakeGeneration)) return;
          }
        }
        completionResolution = resolveCurrentReport();
      }
    } finally {
      state.acceptingMessages = false;
    }
    await closeRecipient();
    state.status = "finishing";
    state.activeToolName = undefined;
    refreshReadAgentStats(state, session);
    markReadAgentActivity(state, "sending report", "finishing");
    options.renderReadAgentStatus();

    if (state.stopRequested || !options.isCurrentReadAgentRun(key, state)) return;
    if (pendingChildParent && !submittedFinalReport) return;

    completionResolution ??= resolveCurrentReport();
    if (completionResolution.terminalFailure) {
      throw unavailableReportError(completionResolution.terminalFailure);
    }
    if (!completionResolution.report) {
      throw unavailableReportError(
        completionResolution.recoveryReason ?? "The agent completed without producing any usable final report.",
      );
    }
    const completionSummary = completionResolution.summary
      ?? `${role === "write" ? "Edit" : "Read"} agent ${member.name} completed`;
    const recoveryReference = readAgentRecoveryReference(readTeamName, member.name, state.runId, childSessionManager);
    await deliverCompletion(completionResolution, completionSummary, recoveryAttempted, recoveryReference);
    costOutcome = "completed";
  } catch (e) {
    await cancelAutomaticRepair().catch(() => {});
    if (!state.stopRequested) costOutcome = "failed";
    const lastError = runtime.createRuntimeError(e);
    state.lastError = lastError;
    options.renderReadAgentStatus();
    settleSessionCreation(state.session);
    await closeRecipient();
    if (!state.stopRequested && options.isCurrentReadAgentRun(key, state) && !completedReportPersisted) {
      let failureReport = `${role === "write" ? "Edit" : "Read"} agent ${member.name} failed: ${e instanceof Error ? e.message : String(e)}`;
      const failureStats = state.session?.getSessionStats();
      const reportUnavailable = e instanceof ReadAgentReportUnavailableError ? e : undefined;
      const failureRecoveryReference = childSessionManager
        ? readAgentRecoveryReference(readTeamName, member.name, state.runId, childSessionManager)
        : undefined;
      const failureReportMetadata = {
        reportSource: reportUnavailable?.reportSource ?? "runtime-failure" as AgentReportSource,
        recoveryAttempted: reportUnavailable?.recoveryAttempted ?? false,
        ...((reportUnavailable?.recoverySessionId ?? failureRecoveryReference?.sessionId)
          ? { recoverySessionId: reportUnavailable?.recoverySessionId ?? failureRecoveryReference?.sessionId }
          : {}),
        ...((reportUnavailable?.recoverySessionFile ?? failureRecoveryReference?.sessionFile)
          ? { recoverySessionFile: reportUnavailable?.recoverySessionFile ?? failureRecoveryReference?.sessionFile }
          : {}),
      };
      const failureSummary = `${role === "write" ? "Edit" : "Read"} agent ${member.name} failed`;
      const result = resolvedTaskResult ?? createReportResult(readTeamName, member.name, state.runId, {});
      if (!resolvedTaskResult && assignedChecks?.length) {
        result.verification = { state: "pending", checkIds: assignedCheckIds(result, assignedChecks) };
      }
      const failureEventPersistence = await recordReadAgentReportEvent(
        state,
        () => options.isCurrentReadAgentRun(key, state),
        readTeamName,
        member,
        "failed",
        failureReport,
        failureSummary,
        state.startedAt,
        state.tokensUsed,
        result,
        failureStats?.cost,
        "red",
        failureReportMetadata,
      );
      if (!failureEventPersistence.persisted) {
        const recoveryReference = failureRecoveryReference
          ?? readAgentRecoveryReference(readTeamName, member.name, state.runId, childSessionManager);
        state.finalizationBlockedReason ||= reportPersistenceBlockReason(
          "Could not durably persist the failed read-agent report",
          failureEventPersistence.error,
          recoveryReference,
        );
        if (!failureReport.includes("Recovery pointer: pi-child-session/v1")) {
          failureReport = `${failureReport}\n\n${state.finalizationBlockedReason}`;
        }
      }
      if (member.checkpointAssignment && (state.stopRequested || !options.isCurrentReadAgentRun(key, state))) return;
      options.rememberCompletedAgentReport(readTeamName, {
        name: member.name,
        role,
        status: "failed",
        result,
        report: failureReport,
        summary: failureSummary,
        completedAt: Date.now(),
        startedAt: state.startedAt,
        elapsedMs: Date.now() - state.startedAt,
        tokensUsed: state.tokensUsed,
        costUsd: failureStats?.cost,
        model: member.model,
        thinking: member.thinking,
        modelSlot,
        color: "red",
        requestedBy: member.requestedBy,
        initialPrompt: member.prompt || prompt,
        ...failureReportMetadata,
        source: "read-agent",
      });
      const failureMetadata = {
        finalReport: true,
        startedAt: state.startedAt,
        elapsedMs: Date.now() - state.startedAt,
        tokensUsed: state.tokensUsed,
        costUsd: failureStats?.cost,
        model: member.model,
        thinking: member.thinking,
        modelSlot,
        initialPrompt: member.prompt || prompt,
        ...failureReportMetadata,
      };
      const suppressLeadReportInjection = shouldSuppressLeadReportInjection(member);
      if (member.completionGroup && !member.requestedBy && failureEventPersistence.persisted) {
        await deliverGroupedReport(failureEventPersistence.event, failureReport);
      } else if (member.requestedBy) {
        await ensureReadHelperCompletionMessages(
          readTeamName,
          member,
          state.startedAt,
          state.runId,
          failureReport,
          "failed",
          "red",
          options
        );
        await options.renderLeadInboxStatus?.().catch(() => {});
        await options.notifyLeadOfInboxReports?.(readTeamName).catch(() => {});
      } else if (suppressLeadReportInjection) {
        if (isPiPromptPlanningMember(member)) {
          options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed, failureReport, false, true);
        }
        // Workflow orchestrators consume full failure reports from TeamReportEvent storage.
      } else if (!options.isTeammate && (options.getTeamName() === readTeamName || readTeamName.startsWith("prompt-build-"))) {
        options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed, failureReport, false);
      } else {
        await ensureLeadCompletionMessage(readTeamName, member, state.startedAt, failureReport, failureSummary, "red", failureMetadata);
      }
      try {
        await runtime.writeRuntimeStatus(readTeamName, member.name, state.runId, {
          lastHeartbeatAt: Date.now(),
          lastError,
        });
      } catch {
        // Ignore runtime cleanup races.
      }
    }
  } finally {
    childLifecycleProbeUnsubscribe();
    if (state.stopRequested) await cancelAutomaticRepair().catch(() => {});
    repairCancellationHandlers.delete(state);
    pendingParentWakeSignals.delete(state);
    disposeReadAgentWake(state);
    settleSessionCreation(state.session);
    // End run-owned activity even when persisted lifecycle cleanup is refused.
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = undefined;
    closeReadAgentMessageDelivery(state);
    if (handoffRequested) { state.resolveFinished?.(); return; }
    const teardown = await shutdownTeammate(readTeamName, member, { reason: "quit" });
    if (pendingChildController && pendingChildParent) {
      pendingChildController.forgetParent(pendingChildParent);
    }
    if (!teardown.finalized) options.renderReadAgentStatus();
  }
}
