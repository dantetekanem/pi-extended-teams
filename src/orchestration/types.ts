import type { AgentRuntimeStatus } from "../utils/runtime";
import type { QueuedWriteSpawn } from "../utils/write-queue";
import type { FileClaim } from "../utils/claims";
import type { InboxMessage, Member, TaskFile, TeamConfig, TeamReportEvent, ThinkingLevel } from "../utils/models";

export type { InboxMessage, Member, TaskFile, TeamConfig, TeamReportEvent, ThinkingLevel };

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
  defaultModel?: string;
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
  role?: "read" | "write";
  category?: string;
  model?: string;
  thinking?: ThinkingLevel;
  planModeRequired?: boolean;
  color?: string;
}

export type SpawnTeammateOnceStatus = "existing" | "queued" | "started" | "not_started";
export type TeammateModelSource = "explicit" | "category" | "role" | "team" | "current" | "none" | "existing" | "queued";

export interface TeammateResolutionDetails {
  requestedRole?: "read" | "write";
  role?: "read" | "write" | string;
  resolvedRole?: "read" | "write" | string;
  requestedCategory?: string | null;
  category?: string | null;
  resolvedCategory?: string | null;
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
