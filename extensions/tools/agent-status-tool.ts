import { Type } from "@sinclair/typebox";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as reportEvents from "../../src/utils/report-events";
import { readLifecycleTombstone, type LifecycleTombstoneReadResult } from "../../src/utils/lifecycle-tombstone";
import type { Member, TeamReportEvent } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import { isWriteMemberAlive } from "../team/roster";
import { describeReadAgentStatus } from "../ui/read-agent-status";
import { formatElapsed } from "../ui/renderers";

export type AgentStatusPhase =
  | RunningReadAgent["status"]
  | TeamReportEvent["status"]
  | "queued"
  | "stalled"
  | "stopping"
  | "quarantined"
  | "persistence-failed";

export interface QueuedAgentStatus {
  name: string;
  role: string;
  queuedAt: number;
  queuePosition: number;
  parentAgentName?: string;
  parentLifecycleRunId?: string;
}

export interface AgentStatusScope {
  parentName: string;
  parentRunId: string;
  parentStartedAt: number;
}

export interface AgentStatusSnapshot {
  name: string;
  role: string;
  phase: AgentStatusPhase;
  progress?: string;
  progressAgeMs?: number;
  activeTool?: string;
  activityAgeMs?: number;
  heartbeatAgeMs?: number;
  queuePosition?: number;
  queuedAgeMs?: number;
  completedAgeMs?: number;
  summary?: string;
  error?: string;
}

export interface AgentStatusToolOptions {
  getTeamName(): string | null | undefined;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  terminal: any;
  listQueuedAgents(teamName: string): QueuedAgentStatus[] | Promise<QueuedAgentStatus[]>;
  scope?: AgentStatusScope;
}

export const AGENT_WAIT_CONTRACT = "Reports arrive automatically as new turns. End this turn to wait. Use get_agent_status once for a current snapshot; do not poll.";

function age(now: number, timestamp?: number): number | undefined {
  return timestamp === undefined ? undefined : Math.max(0, now - timestamp);
}

function ownsMember(member: Member, scope?: AgentStatusScope): boolean {
  if (member.name === "team-lead") return false;
  if (!scope) return member.delegationDepth !== 1 && member.helperKind !== "read_helper";
  return member.parentAgentName === scope.parentName
    && member.parentLifecycleRunId === scope.parentRunId;
}

function ownsQueue(item: QueuedAgentStatus, scope?: AgentStatusScope): boolean {
  if (!scope) return !item.parentAgentName;
  return item.parentAgentName === scope.parentName
    && item.parentLifecycleRunId === scope.parentRunId;
}

function ownsReport(report: TeamReportEvent, scope?: AgentStatusScope): boolean {
  if (!scope) return !report.requestedBy;
  const parentRunId = report.metadata?.parentLifecycleRunId;
  return report.requestedBy === scope.parentName
    && report.createdAt >= scope.parentStartedAt
    && (typeof parentRunId !== "string" || parentRunId === scope.parentRunId);
}

function lifecycleMatches(member: Member, runId?: string): boolean {
  return member.lifecycleRunId === runId;
}

function persistedLifecycleStatus(
  member: Member,
  result: LifecycleTombstoneReadResult,
): Pick<AgentStatusSnapshot, "phase" | "error"> | undefined {
  if (result.status === "absent") return undefined;
  if (result.status === "corrupt") return { phase: "quarantined", error: result.error };

  const tombstone = result.tombstone;
  const runMismatch = member.lifecycleRunId && tombstone.runId !== member.lifecycleRunId
    ? `Lifecycle fence belongs to run ${tombstone.runId}, not roster run ${member.lifecycleRunId}.`
    : undefined;
  const phase = tombstone.phase === "cleanup_failed" || tombstone.phase === "timed_out"
    ? "quarantined"
    : "stopping";
  return { phase, error: runMismatch || tombstone.error };
}

function phaseForActiveAgent(
  member: Member,
  state: RunningReadAgent | undefined,
  runtimeStatus: runtime.AgentRuntimeStatus | null,
  persistedStatus: Pick<AgentStatusSnapshot, "phase" | "error"> | undefined,
  now: number,
  terminal: any,
): AgentStatusPhase {
  if (state?.teardownState === "persistence_failed") return "persistence-failed";
  if (state?.teardownState === "quarantined") return "quarantined";
  if (state?.teardownState === "stopping") return "stopping";
  if (persistedStatus) return persistedStatus.phase;
  if (state && state.teardownState !== "finalized") {
    return describeReadAgentStatus(state, now).label === "hanging" ? "stalled" : state.status;
  }

  const heartbeatFresh = runtime.isHeartbeatFresh(runtimeStatus, now);
  const paneAlive = member.isActive !== false && isWriteMemberAlive(member, terminal);
  if (!heartbeatFresh && !paneAlive) {
    if (member.isActive !== false && !runtimeStatus?.ready && now - member.joinedAt <= runtime.STARTUP_STALL_MS) return "starting";
    return "stalled";
  }

  const action = runtimeStatus?.currentAction;
  if (action) return action === "done" ? "finishing" : action;
  return runtimeStatus?.ready ? "working" : "starting";
}

async function activeStatus(
  teamName: string,
  member: Member,
  options: AgentStatusToolOptions,
  now: number,
): Promise<AgentStatusSnapshot> {
  const candidateState = options.runningReadAgents.get(options.readAgentKey(teamName, member.name));
  const [candidateRuntimeStatus, lifecycleResult] = await Promise.all([
    runtime.readRuntimeStatus(teamName, member.name).catch(() => null),
    readLifecycleTombstone(teamName, member.name).catch(error => ({
      status: "corrupt" as const,
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const state = candidateState && lifecycleMatches(member, candidateState.runId)
    ? candidateState
    : undefined;
  const runtimeStatus = candidateRuntimeStatus && lifecycleMatches(member, candidateRuntimeStatus.lifecycleRunId)
    ? candidateRuntimeStatus
    : null;
  const persistedStatus = persistedLifecycleStatus(member, lifecycleResult);
  const progress = state?.latestProgress || runtimeStatus?.latestProgress;
  const progressUpdatedAt = state?.progressUpdatedAt || runtimeStatus?.progressUpdatedAt;
  return {
    name: member.name,
    role: member.role || state?.role || "read",
    phase: phaseForActiveAgent(member, state, runtimeStatus, persistedStatus, now, options.terminal),
    progress,
    progressAgeMs: age(now, progressUpdatedAt),
    activeTool: state?.activeToolName || runtimeStatus?.activeToolName,
    activityAgeMs: age(now, state?.lastActivityAt),
    heartbeatAgeMs: age(now, runtimeStatus?.lastHeartbeatAt),
    error: state?.lastError?.message || persistedStatus?.error || runtimeStatus?.lastError?.message,
  };
}

function queuedStatus(item: QueuedAgentStatus, now: number): AgentStatusSnapshot {
  return {
    name: item.name,
    role: item.role,
    phase: "queued",
    queuePosition: item.queuePosition,
    queuedAgeMs: age(now, item.queuedAt),
  };
}

function completedStatus(report: TeamReportEvent, now: number): AgentStatusSnapshot {
  return {
    name: report.agentName,
    role: report.role || "read",
    phase: report.status,
    completedAgeMs: age(now, report.createdAt),
    summary: report.summary,
  };
}

function formatAge(label: string, value?: number): string | undefined {
  return value === undefined ? undefined : `${label}: ${formatElapsed(value)} ago`;
}

export function formatAgentStatusesForModel(statuses: AgentStatusSnapshot[]): string {
  if (statuses.length === 0) return "No active, queued, or recently completed agents in this scope.";

  const blocks = statuses.map(status => {
    const lines = [`${status.name}: ${status.phase} (${status.role})`];
    if (status.progress) lines.push(`  progress: ${status.progress}${status.progressAgeMs === undefined ? "" : ` (${formatElapsed(status.progressAgeMs)} ago)`}`);
    if (status.activeTool) lines.push(`  tool: ${status.activeTool}`);
    const activity = formatAge("activity", status.activityAgeMs)
      ?? formatAge("heartbeat", status.heartbeatAgeMs);
    if (activity) lines.push(`  ${activity}`);
    if (status.queuePosition !== undefined) lines.push(`  queue position: ${status.queuePosition}`);
    const queued = formatAge("queued", status.queuedAgeMs);
    if (queued) lines.push(`  ${queued}`);
    const completed = formatAge(status.phase === "failed" ? "failed" : "completed", status.completedAgeMs);
    if (completed) lines.push(`  ${completed}`);
    if (status.summary) lines.push(`  summary: ${status.summary}`);
    if (status.error) lines.push(`  error: ${status.error}`);
    return lines.join("\n");
  });

  return `${blocks.join("\n\n")}\n\n${AGENT_WAIT_CONTRACT}`;
}

export function createAgentStatusTool(options: AgentStatusToolOptions): any {
  return {
    name: "get_agent_status",
    label: "Get Agent Status",
    description: "Get one read-only snapshot of one or all agents owned by this parent. Omit agent_name to inspect all. This call is allowed when current status is needed; it never waits, polls, stops, or changes agents. Do not call it repeatedly. Final reports arrive automatically and resume this agent.",
    parameters: Type.Object({
      agent_name: Type.Optional(Type.String({ description: "One owned agent to inspect. Omit to inspect all owned agents." })),
    }),
    async execute(_toolCallId: string, params: { agent_name?: string }) {
      const teamName = options.getTeamName();
      if (!teamName) throw new Error("No active agent session. Spawn an agent first.");

      const config = await teams.readConfig(teamName);
      const now = Date.now();
      const activeMembers = config.members.filter(member => ownsMember(member, options.scope));
      const rosterNames = new Set(config.members.map(member => member.name));
      const queued = (await options.listQueuedAgents(teamName))
        .filter(item => ownsQueue(item, options.scope) && !rosterNames.has(item.name));
      const reportSince = options.scope?.parentStartedAt ?? config.createdAt;
      const reports = (await reportEvents.listTeamReportEvents(teamName, {
        since: reportSince,
        agentName: params.agent_name,
      }).catch(() => []))
        .filter(report => ownsReport(report, options.scope));

      const activeStatuses = await Promise.all(activeMembers.map(member => activeStatus(teamName, member, options, now)));
      const queuedStatuses = queued.map(item => queuedStatus(item, now));
      const currentNames = new Set([...activeStatuses, ...queuedStatuses].map(status => status.name));
      const completedByName = new Map<string, TeamReportEvent>();
      for (const report of reports) {
        if (currentNames.has(report.agentName)) continue;
        completedByName.delete(report.agentName);
        completedByName.set(report.agentName, report);
      }
      const completedStatuses = Array.from(completedByName.values()).slice(-20).map(report => completedStatus(report, now));
      const statuses = [...activeStatuses, ...queuedStatuses, ...completedStatuses];
      const selected = params.agent_name
        ? statuses.filter(status => status.name === params.agent_name)
        : statuses;

      if (params.agent_name && selected.length === 0) {
        throw new Error(`Agent ${params.agent_name} has no current status in this scope.`);
      }

      return {
        content: [{ type: "text", text: formatAgentStatusesForModel(selected) }],
        details: { teamName, statuses: selected },
      };
    },
  };
}
