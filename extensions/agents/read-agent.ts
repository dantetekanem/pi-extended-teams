import type { AgentSession } from "@mariozechner/pi-coding-agent";
import * as runtime from "../../src/utils/runtime";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as reportEvents from "../../src/utils/report-events";
import type { Member } from "../../src/utils/models";
import type { CompletedAgentReport, RunningReadAgent } from "../runtime/types";
import { extractTextParts, getLastAssistantText, sanitizeTuiLine } from "../ui/renderers";
import { createAgentCommunicationTools, type SubmittedAgentReport } from "../tools/agent-communication-tools";
import { requireWriteAgentTeam } from "../team/roster";
import { isPiPromptPlanningMember, shouldSuppressLeadReportInjection } from "../../src/utils/workflow-metadata";
import { canonicalPersistedModelSlot, loadSettings, requireFavoriteModelLevel } from "../../src/utils/settings";
import { closePersistedRecipient } from "../team/recipient-closure";
import { generateExtensionInstanceId, generateLifecycleRunId } from "../../src/utils/lifecycle-tombstone";
import { createLifecycleRuntime, type ShutdownTeammateOptions } from "../team/lifecycle";
import {
  createSpawnResourcePlan,
  parentProjectTrustForSpawn,
  type SpawnResourcePlan,
} from "../resources/spawn-resource-plan";
import { loadPiRuntimeApi } from "../internal/pi-runtime-api";
import {
  closeReadAgentMessageDelivery,
  enqueueReadAgentMessageDelivery,
  installReadAgentSessionLifecycle,
  type ReadAgentDeliveryCloseResult,
  type ReadAgentTeardownResult,
} from "./read-agent-session-lifecycle";

export { closeReadAgentMessageDelivery } from "./read-agent-session-lifecycle";

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
  deliverMessageToActiveAgent?(teamName: string, recipient: string, content: string): Promise<boolean>;
  createResourcePlan?(input: { cwd: string; projectTrusted: boolean }): SpawnResourcePlan | Promise<SpawnResourcePlan>;
  extensionInstanceId?: string;
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

function refreshReadAgentStats(agent: RunningReadAgent, session: AgentSession): void {
  const tokensUsed = session.getSessionStats().tokens.total;
  if (tokensUsed !== agent.tokensUsed) {
    agent.lastActivityAt = Date.now();
    agent.idleNudgeLevel = undefined;
  }
  agent.tokensUsed = tokensUsed;
}

function assistantProgressSnippet(message: any): string | undefined {
  if (message?.role !== "assistant") return undefined;
  const text = sanitizeTuiLine(extractTextParts(message.content)).trim();
  if (!text) return undefined;
  return text.length > 180 ? `…${text.slice(-179)}` : text;
}

function updateAssistantProgress(agent: RunningReadAgent, message: any, recordEvent: boolean): boolean {
  const snippet = assistantProgressSnippet(message);
  if (!snippet || snippet === agent.latestAssistantSnippet) return false;
  agent.latestAssistantSnippet = snippet;
  agent.lastActivityAt = Date.now();
  agent.idleNudgeLevel = undefined;
  if (recordEvent) pushReadAgentEvent(agent, `assistant: ${snippet}`);
  return true;
}

export async function sendMessageToRunningReadAgent(agent: RunningReadAgent | undefined, content: string): Promise<boolean> {
  if (!agent) return false;
  if (!agent.session || !agent.acceptingMessages || agent.messageDeliveryClosed || agent.stopRequested) {
    throw new Error(`Cannot send message to ${agent.name}: agent is finishing.`);
  }

  const session = agent.session;
  const delivery = session.isStreaming ? { deliverAs: "steer" as const } : undefined;
  await enqueueReadAgentMessageDelivery(
    agent,
    agent.name,
    () => session.sendUserMessage(content, delivery)
  );
  markReadAgentActivity(agent, "received lead message", "thinking");
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

async function recordReadAgentReportEvent(
  teamName: string,
  member: Member,
  status: "completed" | "failed",
  report: string,
  summary: string,
  startedAt: number,
  tokensUsed: number,
  costUsd?: number,
  color?: string
): Promise<void> {
  const operation = operationMetadataFromMember(member);
  const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
  await reportEvents.appendTeamReportEvent(teamName, {
    agentName: member.name,
    role: member.role || "read",
    status,
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
    metadata: { ...(member.prompt ? { initialPrompt: member.prompt } : {}), ...(modelSlot ? { modelSlot } : {}) },
  }).catch(() => {});
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
  deliverMessageToActiveAgent?: RunReadAgentOptions["deliverMessageToActiveAgent"]
): Promise<void> {
  if (!member.requestedBy) return;

  let requesterReceivedReport = false;
  try {
    const deliveredDirectly = await deliverMessageToActiveAgent?.(teamName, member.requestedBy, report) === true;
    if (deliveredDirectly) {
      requesterReceivedReport = true;
    } else {
      requesterReceivedReport = await hasRecentMessageFrom(
        teamName,
        member.name,
        member.requestedBy,
        startedAt,
        message => message?.metadata?.helperReport === true && message?.metadata?.runId === runId
      );
      if (!requesterReceivedReport) {
        await messaging.sendPlainMessageIfRunning(
          teamName,
          member.name,
          member.requestedBy,
          report,
          outcome === "failed" ? `Read helper ${member.name} failed` : `Read helper ${member.name} report`,
          color,
          { metadata: { helperReport: true, helperCompletion: true, runId, outcome, requestedBy: member.requestedBy } }
        );
        requesterReceivedReport = true;
      }
    }
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
  if (teams.teamExists(readTeamName)) {
    lifecycleRunId = await teams.ensureMemberLifecycleRunId(readTeamName, member.name, lifecycleRunId);
  }
  member.lifecycleRunId = lifecycleRunId;
  const extensionInstanceId = options.extensionInstanceId ?? generateExtensionInstanceId();
  const state: RunningReadAgent = {
    runId: lifecycleRunId,
    name: member.name,
    teamName: readTeamName,
    role,
    startedAt: Date.now(),
    tokensUsed: 0,
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

  let submittedFinalReport: SubmittedAgentReport | undefined;
  let finalReportSubmissionInProgress = false;

  const closeRecipient = async (): Promise<ReadAgentDeliveryCloseResult> => {
    const deliveryClose = closeReadAgentMessageDelivery(state);
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

  const deliverCompletion = async (report: string, completionSummary: string): Promise<void> => {
    const session = state.session;
    if (!session) throw new Error(`Agent ${member.name} completed without a nested session.`);
    const completionStats = session.getSessionStats();
    options.rememberCompletedAgentReport(readTeamName, {
      name: member.name,
      role,
      status: "completed",
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
    };
    await recordReadAgentReportEvent(readTeamName, member, "completed", report, completionSummary, state.startedAt, state.tokensUsed, completionStats.cost);
    const suppressLeadReportInjection = shouldSuppressLeadReportInjection(member);
    if (member.requestedBy) {
      await ensureReadHelperCompletionMessages(
        readTeamName,
        member,
        state.startedAt,
        state.runId,
        report,
        "completed",
        member.color,
        options.deliverMessageToActiveAgent
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
      options.emitAgentReport(readTeamName, member.name, state.startedAt, state.tokensUsed, report, true);
    } else {
      await ensureLeadCompletionMessage(readTeamName, member, state.startedAt, report, completionSummary, member.color, completionMetadata);
    }
  };

  try {
    const [provider, modelId] = (member.model || "").split("/", 2);
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
    const loader = new DefaultResourceLoader({
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
        member.requestedBy
          ? `You are a read helper requested by '${member.requestedBy}'. When finished, send your concise report to the lead and stop.`
          : "You cannot spawn or create other agents. If another agent is needed, use send_message to ask team-lead; only the lead decides and performs the spawn.",
        "NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.",
        "When finished, use report_and_exit with the complete required deliverable in content and only a short label in summary, then stop. Never replace required output with a summary. Do not wait for the lead to kill you — report and exit cleanly.",
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
      onReportAndExit: async report => {
        if (submittedFinalReport || finalReportSubmissionInProgress) return { accepted: false };
        finalReportSubmissionInProgress = true;
        try {
          const deliveryClose = await closeRecipient();
          submittedFinalReport = report;
          return {
            accepted: true,
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
    const extensionToolNames = loader.getExtensions().extensions.flatMap(extension => {
      return Array.from(extension.tools.keys()).filter(name => !communicationToolNameSet.has(name));
    });
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
    ]));

    const { session } = await createAgentSession({
      cwd: member.cwd,
      model,
      thinkingLevel: member.thinking as any,
      modelRegistry: ctx.modelRegistry,
      tools: activeToolNames,
      customTools: communicationTools,
      resourceLoader: loader,
      settingsManager: childSettingsManager,
      sessionManager: SessionManager.inMemory(member.cwd),
    });

    state.session = session;
    installReadAgentSessionLifecycle(session);
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
    markReadAgentActivity(state, "started", "thinking");
    options.renderReadAgentStatus();

    session.subscribe((event: any) => {
      if (event.type === "agent_start" || event.type === "turn_start") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "message_update" && updateAssistantProgress(state, event.message, false)) {
        state.status = "thinking";
        state.activeToolName = undefined;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        updateAssistantProgress(state, event.message, true);
      }
      if (event.type === "tool_execution_start") {
        markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
      }
      if (event.type === "tool_execution_update") {
        markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
      }
      if (event.type === "tool_execution_end") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "agent_end") pushReadAgentEvent(state, "agent complete");
      if (event.type === "message_update" || event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
        try {
          refreshReadAgentStats(state, session);
          options.renderReadAgentStatus();
        } catch {
          // Ignore stats races while the nested session is shutting down.
        }
      }
    });

    state.acceptingMessages = true;
    try {
      await session.prompt(prompt, { source: "extension" as any });
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

    const report = submittedFinalReport?.content
      ?? (getLastAssistantText(session.messages) || "Read agent completed, but produced no assistant text.");
    const completionSummary = submittedFinalReport?.summary
      ?? `${role === "write" ? "Edit" : "Read"} agent ${member.name} completed`;
    await deliverCompletion(report, completionSummary);
  } catch (e) {
    settleSessionCreation(state.session);
    await closeRecipient();
    if (!state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
      const failureReport = `${role === "write" ? "Edit" : "Read"} agent ${member.name} failed: ${e instanceof Error ? e.message : String(e)}`;
      const failureStats = state.session?.getSessionStats();
      options.rememberCompletedAgentReport(readTeamName, {
        name: member.name,
        role,
        status: "failed",
        report: failureReport,
        summary: `${role === "write" ? "Edit" : "Read"} agent ${member.name} failed`,
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
        source: "read-agent",
      });
      const failureSummary = `${role === "write" ? "Edit" : "Read"} agent ${member.name} failed`;
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
      };
      await recordReadAgentReportEvent(readTeamName, member, "failed", failureReport, failureSummary, state.startedAt, state.tokensUsed, failureStats?.cost, "red");
      const suppressLeadReportInjection = shouldSuppressLeadReportInjection(member);
      if (member.requestedBy) {
        await ensureReadHelperCompletionMessages(
          readTeamName,
          member,
          state.startedAt,
          state.runId,
          failureReport,
          "failed",
          "red",
          options.deliverMessageToActiveAgent
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
          lastError: runtime.createRuntimeError(e),
        });
      } catch {
        // Ignore runtime cleanup races.
      }
    }
  } finally {
    settleSessionCreation(state.session);
    const teardown = await shutdownTeammate(readTeamName, member, { reason: "quit" });
    if (!teardown.finalized) options.renderReadAgentStatus();
  }
}
