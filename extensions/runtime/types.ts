import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface RunningReadAgent {
  runId: string;
  name: string;
  teamName: string;
  startedAt: number;
  tokensUsed: number;
  status: "starting" | "running" | "finishing";
  recentEvents: string[];
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
  model?: string;
  thinking?: string;
  color?: string;
  source: "read-agent" | "lead-inbox";
}
