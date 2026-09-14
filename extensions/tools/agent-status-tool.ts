import { Type } from "@sinclair/typebox";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as reportEvents from "../../src/utils/report-events";
import { listLifecycleTombstones, readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone";
import { projectAgentStatus, projectLifecycleFence, type ActiveAgentPhase } from "../../src/orchestration/status-projection";
import type { Member, TeamReportEvent } from "../../src/utils/models";
import type { ReportResult } from "../../src/results/report-result";
import type { RunningReadAgent } from "../runtime/types";
import { isWriteMemberAlive } from "../team/roster";
import { formatElapsed } from "../ui/renderers";

export type AgentStatusPhase = ActiveAgentPhase | TeamReportEvent["status"] | "queued";

export interface QueuedAgentStatus {
  name: string;
  role: string;
  queuedAt: number;
  queuePosition: number;
  error?: string;
  failed?: boolean;
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
  runId?: string;
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
  taskId?: string;
  reportId?: string;
  outcome?: ReportResult["outcome"];
  verification?: ReportResult["verification"]["state"];
  acceptance?: ReportResult["acceptance"]["state"];
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
  const projected = projectAgentStatus({
    member, activity: candidateState, runtime: candidateRuntimeStatus, fence: lifecycleResult,
    terminalAlive: member.tmuxPaneId && options.terminal?.isAlive ? isWriteMemberAlive(member, options.terminal) : null,
    now,
  });
  const { state, runtime: runtimeStatus } = projected;
  const progress = state?.latestProgress || runtimeStatus?.latestProgress;
  const progressUpdatedAt = state?.progressUpdatedAt || runtimeStatus?.progressUpdatedAt;
  return {
    name: member.name,
    role: member.role || state?.role || "read",
    phase: projected.phase,
    progress,
    progressAgeMs: age(now, progressUpdatedAt),
    activeTool: state?.activeToolName || runtimeStatus?.activeToolName,
    activityAgeMs: age(now, state?.lastActivityAt),
    heartbeatAgeMs: age(now, runtimeStatus?.lastHeartbeatAt),
    error: projected.error,
  };
}

function queuedStatus(item: QueuedAgentStatus, now: number): AgentStatusSnapshot {
  return {
    name: item.name,
    role: item.role,
    phase: item.failed ? "failed" : "queued",
    error: item.error,
    queuePosition: item.queuePosition,
    queuedAgeMs: age(now, item.queuedAt),
  };
}

function completedStatus(report: TeamReportEvent, now: number): AgentStatusSnapshot {
  return {
    name: report.agentName,
    role: report.role || "read",
    phase: report.status,
    ...(report.result && {
      taskId: report.result.taskId, runId: report.result.runId, reportId: report.result.reportId,
      outcome: report.result.outcome, verification: report.result.verification.state, acceptance: report.result.acceptance.state,
      error: report.result.verification.error,
    }),
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
    if (status.runId) lines.push(`  run: ${status.runId}`);
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
    if (status.reportId) lines.push(`  task: ${status.outcome ?? "unspecified"}; verification: ${status.verification}; acceptance: ${status.acceptance}`);
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
      // Orphan fences lack parent metadata; only the lead can inspect them.
      const fencedStatuses: AgentStatusSnapshot[] = options.scope ? [] : (await listLifecycleTombstones(teamName))
        .filter(({ agentName }) => !rosterNames.has(agentName))
        .map(({ agentName, result }) => {
          const pending = queued.find(item => item.name === agentName);
          return {
            ...(pending ? queuedStatus(pending, now) : {}),
            name: agentName,
            runId: result.status === "occupied" ? result.tombstone.runId : undefined,
            role: result.status === "occupied" ? result.tombstone.role : pending?.role || "unknown",
            ...projectLifecycleFence({}, result),
          };
        });
      const fencedNames = new Set(fencedStatuses.map(status => status.name));
      const queuedStatuses = queued.filter(item => !fencedNames.has(item.name)).map(item => queuedStatus(item, now));
      const currentNames = new Set([...activeStatuses, ...fencedStatuses, ...queuedStatuses].map(status => status.name));
      const completedByName = new Map<string, TeamReportEvent>();
      for (const report of reports) {
        if (currentNames.has(report.agentName)) continue;
        completedByName.delete(report.agentName);
        completedByName.set(report.agentName, report);
      }
      const completedStatuses = Array.from(completedByName.values()).slice(-20).map(report => completedStatus(report, now));
      const statuses = [...activeStatuses, ...fencedStatuses, ...queuedStatuses, ...completedStatuses];
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
