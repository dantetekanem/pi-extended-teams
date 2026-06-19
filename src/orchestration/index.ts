import * as teams from "../utils/teams";
import * as tasks from "../utils/tasks";
import * as claims from "../utils/claims";
import * as messaging from "../utils/messaging";
import * as runtime from "../utils/runtime";
import * as writeQueue from "../utils/write-queue";
import * as reports from "../utils/report-events";
import type { Member } from "../utils/models";
import type {
  BroadcastMessageOnceRequest,
  EnsureTeamRequest,
  EnsureTeamResponse,
  ObserveRuntimeOptions,
  SendMessageOnceRequest,
  SpawnTeammateOnceOptions,
  SpawnTeammateOnceRequest,
  SpawnTeammateOnceResponse,
  TeamObservation,
  TeammateResolutionDetails,
  TeammateHealth,
  TeammateObservation,
} from "./types";

export * from "./types";
export { appendTeamReportEvent, listTeamReportEvents } from "../utils/report-events";
export { peekInbox } from "../utils/messaging";
export { updateTaskGuarded } from "../utils/tasks";

function readAgentIsKnownRunning(teamName: string, agentName: string, options: ObserveRuntimeOptions): boolean {
  const key = options.readAgentKey?.(teamName, agentName) || `${teamName}:${agentName}`;
  return !!options.runningReadAgents?.has(key);
}

function operationValue(source: { operationId?: string; workflowRunId?: string; metadata?: Record<string, any> }, key: "operationId" | "workflowRunId"): string | undefined {
  return source[key] || source.metadata?.[key] || source.metadata?.orchestration?.[key];
}

function memberMatchesOperation(member: Member, request: { operationId?: string; workflowRunId?: string }): boolean {
  if (!request.operationId) return false;
  const operationId = operationValue(member, "operationId");
  const workflowRunId = operationValue(member, "workflowRunId");
  return operationId === request.operationId && (request.workflowRunId === undefined || workflowRunId === request.workflowRunId);
}

function metadataForOperation(request: { operationId?: string; workflowRunId?: string; metadata?: Record<string, any> }): Record<string, any> | undefined {
  const metadata = { ...(request.metadata || {}) };
  if (request.operationId) metadata.operationId = request.operationId;
  if (request.workflowRunId) metadata.workflowRunId = request.workflowRunId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function memberResolutionDetails(member: Member, request: Partial<SpawnTeammateOnceRequest>, extras: Record<string, any> = {}): TeammateResolutionDetails & Record<string, any> {
  const role = member.role ?? "write";
  const category = member.category ?? null;
  return {
    agentId: member.agentId,
    role,
    requestedRole: request.role ?? "read",
    resolvedRole: role,
    requestedCategory: request.category ?? null,
    category,
    resolvedCategory: category,
    model: member.model ?? null,
    thinking: member.thinking ?? null,
    ...extras,
  };
}

function queuedResolutionDetails(teamName: string, queued: writeQueue.QueuedWriteSpawn, request: Partial<SpawnTeammateOnceRequest>, extras: Record<string, any> = {}): TeammateResolutionDetails & Record<string, any> {
  const category = queued.category ?? null;
  return {
    agentId: `${queued.name}@${teamName}`,
    role: "write",
    requestedRole: request.role ?? "read",
    resolvedRole: "write",
    requestedCategory: request.category ?? null,
    category,
    resolvedCategory: category,
    model: queued.model,
    thinking: queued.thinking ?? null,
    modelSource: "queued",
    ...extras,
  };
}

export async function observeTeammate(
  teamName: string,
  agentName: string,
  options: ObserveRuntimeOptions = {}
): Promise<TeammateObservation> {
  const config = await teams.readConfig(teamName);
  const member = config.members.find((item) => item.name === agentName);
  if (!member) throw new Error(`Teammate ${agentName} not found`);

  const role = member.role ?? (member.name === "team-lead" ? "lead" : "write");
  const unreadCount = (await messaging.peekInbox(teamName, member.name, true).catch(() => [])).length;
  const runtimeStatus = member.name === "team-lead" ? null : await runtime.readRuntimeStatus(teamName, member.name).catch(() => null);
  const now = options.now ?? Date.now();
  const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;

  let alive: boolean | null;
  if (member.name === "team-lead") {
    alive = true;
  } else if (role === "read") {
    alive = readAgentIsKnownRunning(teamName, member.name, options) || (!!runtimeStatus && hasRecentHeartbeat && member.isActive !== false);
  } else if (member.tmuxPaneId && options.terminal?.isAlive) {
    alive = options.terminal.isAlive(member.tmuxPaneId);
  } else {
    alive = null;
  }

  const startupStalled = alive === true && unreadCount > 0 && (now - member.joinedAt) > runtime.STARTUP_STALL_MS && !(runtimeStatus?.ready);
  let health: TeammateHealth;
  if (member.name === "team-lead") health = "lead";
  else if (alive === null) health = "unknown";
  else if (!alive) health = "dead";
  else if (startupStalled) health = "stalled";
  else if (runtimeStatus?.ready) health = hasRecentHeartbeat ? "healthy" : "idle";
  else health = "starting";

  return {
    teamName,
    agentName: member.name,
    member,
    role,
    alive,
    health,
    unreadCount,
    agentLoopReady: !!runtimeStatus?.ready,
    hasRecentHeartbeat,
    startupStalled,
    runtime: runtimeStatus,
  };
}

export async function observeTeam(
  teamName: string,
  options: ObserveRuntimeOptions = {}
): Promise<TeamObservation> {
  const config = await teams.readConfig(teamName);
  const [taskList, currentClaims, queue, reportEvents] = await Promise.all([
    tasks.listTasks(teamName).catch(() => []),
    claims.listClaims(teamName).catch(() => []),
    writeQueue.listWriteQueue(teamName).catch(() => []),
    reports.listTeamReportEvents(teamName, { limit: options.reportLimit }).catch(() => []),
  ]);
  const members = await Promise.all(config.members.map((member) => observeTeammate(teamName, member.name, options)));

  return {
    teamName,
    config,
    members,
    tasks: taskList,
    claims: currentClaims,
    writeQueue: queue,
    reports: reportEvents,
  };
}

export async function ensureTeam(request: EnsureTeamRequest): Promise<EnsureTeamResponse> {
  const result = await teams.ensureTeam({
    name: request.teamName,
    sessionId: request.sessionId,
    leadAgentId: request.leadAgentId,
    description: request.description,
    defaultModel: request.defaultModel,
    separateWindows: request.separateWindows,
    metadata: metadataForOperation(request),
  });
  return { config: result.config, created: result.created };
}

export async function spawnTeammateOnce(
  request: SpawnTeammateOnceRequest,
  options: SpawnTeammateOnceOptions = {}
): Promise<SpawnTeammateOnceResponse> {
  const config = await teams.readConfig(request.teamName);
  const existing = config.members.find((member) =>
    member.agentType === "teammate" && (member.name === request.name || memberMatchesOperation(member, request))
  );
  if (existing) {
    return {
      status: "existing",
      member: existing,
      details: memberResolutionDetails(existing, request, { existing: true, idempotent: true, queued: false, modelSource: "existing" }),
    };
  }

  const queued = await writeQueue.findQueuedWriteSpawn(request.teamName, {
    name: request.name,
    operationId: request.operationId,
    workflowRunId: request.workflowRunId,
  }).catch(() => null);
  if (queued) {
    return {
      status: "queued",
      queued,
      details: queuedResolutionDetails(request.teamName, queued, request, { existing: true, idempotent: true, queued: true }),
    };
  }

  if (!options.start) return { status: "not_started", details: { reason: "No spawn start callback supplied", requestedRole: request.role ?? "read", requestedCategory: request.category ?? null, model: request.model ?? null, thinking: request.thinking ?? null } };

  const started = await options.start({ ...request, metadata: metadataForOperation(request) });
  const baseDetails = started.member
    ? memberResolutionDetails(started.member, request)
    : started.queued
      ? queuedResolutionDetails(request.teamName, started.queued, request)
      : {};
  return {
    status: started.queued ? "queued" : "started",
    member: started.member,
    queued: started.queued,
    details: { ...baseDetails, ...started.details },
  };
}

export async function sendMessageOnce(request: SendMessageOnceRequest) {
  return await messaging.sendPlainMessageOnce(
    request.teamName,
    request.fromName,
    request.toName,
    request.text,
    request.summary,
    {
      color: request.color,
      operationId: request.operationId,
      workflowRunId: request.workflowRunId,
      metadata: metadataForOperation(request),
    }
  );
}

export async function broadcastMessageOnce(request: BroadcastMessageOnceRequest) {
  return await messaging.broadcastMessageOnce(
    request.teamName,
    request.fromName,
    request.text,
    request.summary,
    {
      color: request.color,
      operationId: request.operationId,
      workflowRunId: request.workflowRunId,
      metadata: metadataForOperation(request),
    }
  );
}
