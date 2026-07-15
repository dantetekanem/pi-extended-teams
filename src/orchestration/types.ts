import type { AgentRuntimeStatus } from "../utils/runtime";
import type { QueuedWriteSpawn } from "../utils/write-queue";
import type { FileClaim } from "../utils/claims";
import type { InboxMessage, Member, TaskFile, TeamConfig, TeamReportEvent, ThinkingLevel } from "../utils/models";
import type { FavoriteModelSlot } from "../utils/settings";

export type { InboxMessage, Member, TaskFile, TeamConfig, TeamReportEvent, ThinkingLevel, FavoriteModelSlot };

export interface OrchestrationOperationMetadata {
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
}

export type TeammateHealth = "lead" | "healthy" | "idle" | "starting" | "stalled" | "dead" | "unknown";

export interface TeammateObservation {
  teamName: string;
  agentName: string;
  member: Member;
  role: string;
  alive: boolean | null;
  health: TeammateHealth;
  unreadCount: number;
  agentLoopReady: boolean;
  hasRecentHeartbeat: boolean;
  startupStalled: boolean;
  runtime: AgentRuntimeStatus | null;
}

export interface TeamObservation {
  teamName: string;
  config: TeamConfig;
  members: TeammateObservation[];
  tasks: TaskFile[];
  claims: FileClaim[];
  writeQueue: QueuedWriteSpawn[];
  reports: TeamReportEvent[];
}

export interface ObserveRuntimeOptions {
  terminal?: { isAlive?(terminalId: string): boolean } | null;
  runningReadAgents?: Map<string, unknown>;
  readAgentKey?: (teamName: string, agentName: string) => string;
  now?: number;
  reportLimit?: number;
}

export interface EnsureTeamRequest extends OrchestrationOperationMetadata {
  teamName: string;
  description?: string;
  /** Intent tier used for the team's internal default model. Defaults to read-review. */
  defaultModelSlot?: FavoriteModelSlot;
  sessionId?: string;
  leadAgentId?: string;
  separateWindows?: boolean;
}

export interface EnsureTeamResponse {
  config: TeamConfig;
  created: boolean;
}

export interface SpawnTeammateOnceRequest extends OrchestrationOperationMetadata {
  teamName: string;
  name: string;
  prompt: string;
  cwd: string;
  /** Required intent tier; selects read/write behavior, configured model, and thinking. */
  modelSlot: FavoriteModelSlot;
  planModeRequired?: boolean;
  color?: string;
}

export type SpawnTeammateOnceStatus = "existing" | "queued" | "started" | "not_started";
export type TeammateModelSource = "favorite-slot" | "existing" | "queued";

export interface TeammateResolutionDetails {
  requestedRole?: "read" | "write";
  role?: "read" | "write" | string;
  resolvedRole?: "read" | "write" | string;
  requestedModelSlot?: FavoriteModelSlot | string | null;
  modelSlot?: FavoriteModelSlot | string | null;
  model?: string | null;
  thinking?: ThinkingLevel | string | null;
  modelSource?: TeammateModelSource | string;
}

export interface SpawnTeammateOnceStartResult {
  member?: Member;
  queued?: QueuedWriteSpawn;
  details?: TeammateResolutionDetails & Record<string, any>;
}

export interface SpawnTeammateOnceOptions {
  start?: (request: SpawnTeammateOnceRequest) => Promise<SpawnTeammateOnceStartResult>;
}

export interface SpawnTeammateOnceResponse {
  status: SpawnTeammateOnceStatus;
  member?: Member;
  queued?: QueuedWriteSpawn;
  details?: Record<string, any>;
}

export type SpawnTeammatesOnceResponse = SpawnTeammateOnceResponse[];

export interface SendMessageOnceRequest extends OrchestrationOperationMetadata {
  teamName: string;
  fromName: string;
  toName: string;
  text: string;
  summary: string;
  color?: string;
  operationId: string;
}

export interface BroadcastMessageOnceRequest extends OrchestrationOperationMetadata {
  teamName: string;
  fromName: string;
  text: string;
  summary: string;
  color?: string;
  operationId: string;
}
