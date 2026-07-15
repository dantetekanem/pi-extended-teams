import * as teams from "../utils/teams";
import * as tasks from "../utils/tasks";
import * as claims from "../utils/claims";
import * as messaging from "../utils/messaging";
import * as runtime from "../utils/runtime";
import * as writeQueue from "../utils/write-queue";
import * as reports from "../utils/report-events";
import type { Member } from "../utils/models";
import { canonicalPersistedModelSlot, loadSettings, requireFavoriteModelLevel, roleForFavoriteModelSlot } from "../utils/settings";
import type {
  BroadcastMessageOnceRequest,
  EnsureTeamRequest,
  EnsureTeamResponse,
  ObserveRuntimeOptions,
  SendMessageOnceRequest,
  SpawnTeammateOnceOptions,
  SpawnTeammateOnceRequest,
  SpawnTeammateOnceResponse,
  SpawnTeammatesOnceResponse,
  TeamObservation,
  TeammateResolutionDetails,
  TeammateHealth,
  TeammateObservation,
} from "./types";

export * from "./types";
export { listTeamReportEvents } from "../utils/report-events";
export { peekInbox } from "../utils/messaging";
export { updateTaskGuarded } from "../utils/tasks";

const reportAppendQueues = new Map<string, Promise<unknown>>();

export async function appendTeamReportEvent(teamName: string, event: reports.NewTeamReportEvent) {
  const previous = reportAppendQueues.get(teamName) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => reports.appendTeamReportEvent(teamName, event));
  let queued: Promise<unknown>;
  queued = next.catch(() => undefined).finally(() => {
    if (reportAppendQueues.get(teamName) === queued) reportAppendQueues.delete(teamName);
  });
  reportAppendQueues.set(teamName, queued);
  return await next;
}

function readAgentIsKnownRunning(teamName: string, agentName: string, options: ObserveRuntimeOptions): boolean {
  const key = options.readAgentKey?.(teamName, agentName) || `${teamName}:${agentName}`;
  return !!options.runningReadAgents?.has(key);
}

function operationValue(source: { operationId?: string; workflowRunId?: string; metadata?: Record<string, any> }, key: "operationId" | "workflowRunId"): string | undefined {
  return source[key] || source.metadata?.[key] || source.metadata?.orchestration?.[key];
}

function metadataForOperation(request: { operationId?: string; workflowRunId?: string; metadata?: Record<string, any> }): Record<string, any> | undefined {
  const metadata = { ...(request.metadata || {}) };
  if (request.operationId) metadata.operationId = request.operationId;
  if (request.workflowRunId) metadata.workflowRunId = request.workflowRunId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function canonicalPersistedMetadata(metadata: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "modelSlot")) return metadata;
  return { ...metadata, modelSlot: canonicalPersistedModelSlot(metadata.modelSlot) };
}

function canonicalPersistedMember(member: Member): Member {
  const projected = { ...member };
  if (Object.prototype.hasOwnProperty.call(member, "modelSlot")) {
    projected.modelSlot = canonicalPersistedModelSlot(member.modelSlot);
  }
  if (Object.prototype.hasOwnProperty.call(member, "metadata")) {
    projected.metadata = canonicalPersistedMetadata(member.metadata);
  }
  return projected;
}

function canonicalPersistedQueuedSpawn(queued: writeQueue.QueuedWriteSpawn): writeQueue.QueuedWriteSpawn {
  const projected = {
    ...queued,
    modelSlot: canonicalPersistedModelSlot(queued.modelSlot),
  };
  if (Object.prototype.hasOwnProperty.call(queued, "metadata")) {
    projected.metadata = canonicalPersistedMetadata(queued.metadata);
  }
  return projected;
}

function memberResolutionDetails(member: Member, request: Partial<SpawnTeammateOnceRequest>, extras: Record<string, any> = {}): TeammateResolutionDetails & Record<string, any> {
  const role = member.role ?? "write";
  return {
    agentId: member.agentId,
    role,
    requestedRole: request.modelSlot ? roleForFavoriteModelSlot(request.modelSlot) : role,
    resolvedRole: role,
    requestedModelSlot: canonicalPersistedModelSlot(request.modelSlot ?? null),
    modelSlot: canonicalPersistedModelSlot(member.modelSlot ?? null),
    model: member.model ?? null,
    thinking: member.thinking ?? null,
    ...extras,
  };
}

function queuedResolutionDetails(teamName: string, queued: writeQueue.QueuedWriteSpawn, request: Partial<SpawnTeammateOnceRequest>, extras: Record<string, any> = {}): TeammateResolutionDetails & Record<string, any> {
  const level = requireFavoriteModelLevel(loadSettings({ projectDir: queued.cwd }), queued.modelSlot);
  return {
    agentId: `${queued.name}@${teamName}`,
    role: "write",
    requestedRole: request.modelSlot ? roleForFavoriteModelSlot(request.modelSlot) : level.role,
    resolvedRole: "write",
    requestedModelSlot: canonicalPersistedModelSlot(request.modelSlot ?? null),
    modelSlot: level.slot,
    model: level.model,
    thinking: level.thinking,
    modelSource: "queued",
    ...extras,
  };
}

type OperationSource = { operationId?: string; workflowRunId?: string; metadata?: Record<string, any> };

interface IndexedCandidate<T extends OperationSource> {
  item: T;
  order: number;
  operationId?: string;
  workflowRunId?: string;
}

interface SpawnOnceTeamState {
  membersByName: Map<string, IndexedCandidate<Member>>;
  membersByOperation: Map<string, Array<IndexedCandidate<Member>>>;
  queuedByName: Map<string, IndexedCandidate<writeQueue.QueuedWriteSpawn>>;
  queuedByOperation: Map<string, Array<IndexedCandidate<writeQueue.QueuedWriteSpawn>>>;
  nextMemberOrder: number;
  nextQueuedOrder: number;
}

function makeIndexedCandidate<T extends OperationSource>(item: T, order: number, fallback?: OperationSource): IndexedCandidate<T> {
  return {
    item,
    order,
    operationId: operationValue(item, "operationId") || (fallback ? operationValue(fallback, "operationId") : undefined),
    workflowRunId: operationValue(item, "workflowRunId") || (fallback ? operationValue(fallback, "workflowRunId") : undefined),
  };
}

function indexOperationCandidate<T extends OperationSource>(index: Map<string, Array<IndexedCandidate<T>>>, candidate: IndexedCandidate<T>): void {
  if (!candidate.operationId) return;
  const existing = index.get(candidate.operationId) || [];
  existing.push(candidate);
  index.set(candidate.operationId, existing);
}

function registerMemberCandidate(state: SpawnOnceTeamState, member: Member, order: number, fallback?: OperationSource): void {
  if (member.agentType !== "teammate") return;
  const candidate = makeIndexedCandidate(member, order, fallback);
  if (!state.membersByName.has(member.name)) state.membersByName.set(member.name, candidate);
  indexOperationCandidate(state.membersByOperation, candidate);
}

function registerQueuedCandidate(state: SpawnOnceTeamState, queued: writeQueue.QueuedWriteSpawn, order: number, fallback?: OperationSource): void {
  const candidate = makeIndexedCandidate(queued, order, fallback);
  if (!state.queuedByName.has(queued.name)) state.queuedByName.set(queued.name, candidate);
  indexOperationCandidate(state.queuedByOperation, candidate);
}

function findOperationCandidate<T extends OperationSource>(
  index: Map<string, Array<IndexedCandidate<T>>>,
  request: OperationSource
): IndexedCandidate<T> | undefined {
  const operationId = operationValue(request, "operationId");
  if (!operationId) return undefined;
  const workflowRunId = operationValue(request, "workflowRunId");
  return index.get(operationId)?.find((candidate) => workflowRunId === undefined || candidate.workflowRunId === workflowRunId);
}

function earlierCandidate<T extends OperationSource>(left?: IndexedCandidate<T>, right?: IndexedCandidate<T>): IndexedCandidate<T> | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.order <= right.order ? left : right;
}

function findExistingMemberCandidate(state: SpawnOnceTeamState, request: SpawnTeammateOnceRequest): IndexedCandidate<Member> | undefined {
  return earlierCandidate(
    state.membersByName.get(request.name),
    findOperationCandidate(state.membersByOperation, request)
  );
}

function findQueuedCandidate(state: SpawnOnceTeamState, request: SpawnTeammateOnceRequest): IndexedCandidate<writeQueue.QueuedWriteSpawn> | undefined {
  return earlierCandidate(
    state.queuedByName.get(request.name),
    findOperationCandidate(state.queuedByOperation, request)
  );
}

function buildSpawnOnceTeamState(config: { members: Member[] }, queue: writeQueue.QueuedWriteSpawn[]): SpawnOnceTeamState {
  const state: SpawnOnceTeamState = {
    membersByName: new Map(),
    membersByOperation: new Map(),
    queuedByName: new Map(),
    queuedByOperation: new Map(),
    nextMemberOrder: config.members.length,
    nextQueuedOrder: queue.length,
  };

  config.members.forEach((member, order) => registerMemberCandidate(state, member, order));
  queue.forEach((queued, order) => registerQueuedCandidate(state, queued, order));
  return state;
}

async function loadSpawnOnceTeamState(teamName: string): Promise<SpawnOnceTeamState> {
  const config = await teams.readConfig(teamName);
  const queue = await writeQueue.listWriteQueue(teamName).catch(() => []);
  return buildSpawnOnceTeamState(config, queue);
}

function notStartedSpawnResponse(request: SpawnTeammateOnceRequest): SpawnTeammateOnceResponse {
  const level = requireFavoriteModelLevel(loadSettings({ projectDir: request.cwd }), request.modelSlot);
  return {
    status: "not_started",
    details: {
      reason: "No spawn start callback supplied",
      requestedRole: level.role,
      requestedModelSlot: level.slot,
      modelSlot: level.slot,
      model: level.model,
      thinking: level.thinking,
    },
  };
}

function responseFromStartedSpawn(
  teamName: string,
  request: SpawnTeammateOnceRequest,
  started: Awaited<ReturnType<NonNullable<SpawnTeammateOnceOptions["start"]>>>
): SpawnTeammateOnceResponse {
  const baseDetails = started.member
    ? memberResolutionDetails(started.member, request)
    : started.queued
      ? queuedResolutionDetails(teamName, started.queued, request)
      : {};
  return {
    status: started.queued ? "queued" : "started",
    member: started.member ? canonicalPersistedMember(started.member) : undefined,
    queued: started.queued ? canonicalPersistedQueuedSpawn(started.queued) : undefined,
    details: { ...baseDetails, ...started.details },
  };
}

async function startSpawnTeammateOnce(
  state: SpawnOnceTeamState,
  request: SpawnTeammateOnceRequest,
  options: SpawnTeammateOnceOptions
): Promise<SpawnTeammateOnceResponse> {
  if (!options.start) return notStartedSpawnResponse(request);

  const started = await options.start({ ...request, metadata: metadataForOperation(request) });
  if (started.member) registerMemberCandidate(state, started.member, state.nextMemberOrder++, request);
  if (started.queued) registerQueuedCandidate(state, started.queued, state.nextQueuedOrder++, request);
  return responseFromStartedSpawn(request.teamName, request, started);
}

async function observeKnownTeammate(
  teamName: string,
  member: Member,
  options: ObserveRuntimeOptions = {}
): Promise<TeammateObservation> {
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

export async function observeTeammate(
  teamName: string,
  agentName: string,
  options: ObserveRuntimeOptions = {}
): Promise<TeammateObservation> {
  const config = await teams.readConfig(teamName);
  const member = config.members.find((item) => item.name === agentName);
  if (!member) throw new Error(`Teammate ${agentName} not found`);
  return observeKnownTeammate(teamName, member, options);
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
  const members = await Promise.all(config.members.map((member) => observeKnownTeammate(teamName, member, options)));

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
  const level = requireFavoriteModelLevel(loadSettings(), request.defaultModelSlot || "read-review");
  const result = await teams.ensureTeam({
    name: request.teamName,
    sessionId: request.sessionId,
    leadAgentId: request.leadAgentId,
    description: request.description,
    defaultModel: level.model,
    separateWindows: request.separateWindows,
    metadata: metadataForOperation(request),
  });
  return { config: result.config, created: result.created };
}

export async function spawnTeammateOnce(
  request: SpawnTeammateOnceRequest,
  options: SpawnTeammateOnceOptions = {}
): Promise<SpawnTeammateOnceResponse> {
  const [result] = await spawnTeammatesOnce([request], options);
  return result;
}

export async function spawnTeammatesOnce(
  requests: SpawnTeammateOnceRequest[],
  options: SpawnTeammateOnceOptions = {}
): Promise<SpawnTeammatesOnceResponse> {
  if (requests.length === 0) return [];

  const stateByTeam = new Map<string, SpawnOnceTeamState>();
  const uniqueTeamNames = [...new Set(requests.map((request) => request.teamName))];
  await Promise.all(uniqueTeamNames.map(async (teamName) => {
    stateByTeam.set(teamName, await loadSpawnOnceTeamState(teamName));
  }));

  const results: SpawnTeammateOnceResponse[] = [];
  for (const request of requests) {
    const state = stateByTeam.get(request.teamName);
    if (!state) throw new Error(`Team ${request.teamName} not found`);

    const existing = findExistingMemberCandidate(state, request)?.item;
    if (existing) {
      results.push({
        status: "existing",
        member: canonicalPersistedMember(existing),
        details: memberResolutionDetails(existing, request, { existing: true, idempotent: true, queued: false, modelSource: "existing" }),
      });
      continue;
    }

    const queued = findQueuedCandidate(state, request)?.item;
    if (queued) {
      results.push({
        status: "queued",
        queued: canonicalPersistedQueuedSpawn(queued),
        details: queuedResolutionDetails(request.teamName, queued, request, { existing: true, idempotent: true, queued: true }),
      });
      continue;
    }

    results.push(await startSpawnTeammateOnce(state, request, options));
  }

  return results;
}

export async function sendMessageOnce(request: SendMessageOnceRequest) {
  return await messaging.sendPlainMessageOnceIfRunning(
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
