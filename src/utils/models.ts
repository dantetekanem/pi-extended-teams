import { THINKING_LEVEL_NAMES, type ThinkingLevelName } from "./thinking-levels";

export const THINKING_LEVELS = THINKING_LEVEL_NAMES;
export type ThinkingLevel = ThinkingLevelName;

export interface Member {
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number;
  tmuxPaneId: string;
  windowId?: string;
  cwd: string;
  subscriptions: any[];
  prompt?: string;
  color?: string;
  thinking?: ThinkingLevel;
  planModeRequired?: boolean;
  backendType?: string;
  isActive?: boolean;
  /** Optional programmatic orchestration/idempotency metadata. */
  metadata?: Record<string, any>;
  /** Authoritative identity for one admitted lifecycle run. Never stored in user metadata. */
  lifecycleRunId?: string;
  /** "read" agents run in-process (no pane); "write" agents spawn in tmux. */
  role?: "read" | "write";
  /** Optional category preset name from settings.json. */
  category?: string;
  /** Optional favorite model slot selected at spawn time. */
  modelSlot?: string;
  /** Agent that requested this read helper; final reports are delivered there. */
  requestedBy?: string;
  /** Marks extension-managed helper agents with special delivery/cleanup semantics. */
  helperKind?: "read_helper";
}

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: Member[];
  defaultModel?: string;
  separateWindows?: boolean;
  /** Optional programmatic orchestration/idempotency metadata. */
  metadata?: Record<string, any>;
}

export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "planning" | "in_progress" | "completed" | "deleted";
  plan?: string;
  planFeedback?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  /** Monotonic task version for guarded programmatic updates. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, any>;
}

export interface InboxMessage {
  id?: string;
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
}

export interface TeamReportEvent {
  id: string;
  teamName: string;
  agentName: string;
  role?: string;
  status: "completed" | "failed";
  report: string;
  summary?: string;
  createdAt: number;
  startedAt?: number;
  elapsedMs?: number;
  tokensUsed?: number;
  costUsd?: number;
  model?: string;
  thinking?: string;
  modelSlot?: string;
  color?: string;
  requestedBy?: string;
  source: "read-agent" | "write-agent" | "lead-inbox" | "tool" | "workflow";
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
}
