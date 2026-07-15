import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ManagedReadAgentLifecycleState } from "../agents/read-agent-session-lifecycle";

export interface RunningReadAgent extends ManagedReadAgentLifecycleState {
  runId: string;
  name: string;
  teamName: string;
  startedAt: number;
  tokensUsed: number;
  status: "starting" | "thinking" | "working" | "finishing";
  recentEvents: string[];
  lastActivityAt: number;
  activeToolName?: string;
  idleNudgeLevel?: "soft" | "hard";
  role?: string;
  model?: string;
  thinking?: string;
  modelSlot?: string;
  latestAssistantSnippet?: string;
  latestProgress?: string;
  progressUpdatedAt?: number;
  session?: AgentSession;
  finished?: Promise<void>;
}

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
  source: "read-agent" | "lead-inbox" | "report-event";
}
