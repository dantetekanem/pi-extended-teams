import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface RunningReadAgent {
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
  session?: AgentSession;
  stopRequested?: boolean;
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
  color?: string;
  requestedBy?: string;
  initialPrompt?: string;
  source: "read-agent" | "lead-inbox" | "report-event";
}
