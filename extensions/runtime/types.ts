import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ContextUsageSnapshot, RuntimeError } from "../../src/utils/runtime";
import type { ManagedReadAgentLifecycleState } from "../agents/read-agent-session-lifecycle";

export interface RunningReadAgent extends ManagedReadAgentLifecycleState {
  runId: string;
  name: string;
  teamName: string;
  startedAt: number;
  tokensUsed: number;
  contextUsage?: ContextUsageSnapshot;
  status: "starting" | "thinking" | "working" | "finishing";
  recentEvents: string[];
  lastActivityAt: number;
  activeToolName?: string;
  /** Monotonic identity for the current nested AgentSession turn. */
  operationGeneration?: number;
  /** Present only while the matching AgentSession turn is active. */
  activeOperationGeneration?: number;
  /** Settles only after the exact active AgentSession turn has unwound. */
  activeOperationSettlementPromise?: Promise<void>;
  /** Marks the exact active turn for an expected command interruption. */
  interruptRequestedGeneration?: number;
  /** Coalesces cancellation of the active turn without exposing teardown state. */
  operationInterruptPromise?: Promise<void>;
  /** Latest settled turn observed by the runner while waiting for post-interrupt work. */
  completedOperationGeneration?: number;
  completedOperationInterrupted?: boolean;
  completedOperationError?: unknown;
  operationAwaitingResume?: boolean;
  lastError?: RuntimeError;
  idleNudgeLevel?: "soft" | "hard";
  role?: string;
  model?: string;
  thinking?: string;
  modelSlot?: string;
  latestAssistantSnippet?: string;
  assistantProgressNormalizedTail?: string;
  assistantProgressTailTruncated?: boolean;
  assistantProgressContentIndex?: number;
  assistantProgressNeedsSeparator?: boolean;
  assistantProgressIncrementalUnsafe?: boolean;
  latestProgress?: string;
  progressUpdatedAt?: number;
  /** Remove the private child transcript only after durable successful reporting and session disposal. */
  cleanupPrivateSessionOnFinalize?: boolean;
  /** Fail finalization closed so runtime, member, fence, and transcript remain recoverable. */
  finalizationBlockedReason?: string;
  session?: AgentSession;
  finished?: Promise<void>;
}

export type AgentReportSource =
  | "report_and_exit"
  | "persisted-report_and_exit"
  | "assistant-text"
  | "persisted-assistant-text"
  | "irrecoverable-empty"
  | "runtime-failure";

export interface CompletedAgentReport {
  name: string;
  role: string;
  status: "completed" | "failed";
  report: string;
  summary?: string;
  completedAt: number;
  startedAt?: number;
  elapsedMs?: number;
  tokensUsed?: number;
  costUsd?: number;
  model?: string;
  thinking?: string;
  modelSlot?: string;
  color?: string;
  requestedBy?: string;
  initialPrompt?: string;
  reportSource?: AgentReportSource;
  recoveryAttempted?: boolean;
  recoverySessionId?: string;
  recoverySessionFile?: string;
  source: "read-agent" | "lead-inbox" | "report-event";
}
