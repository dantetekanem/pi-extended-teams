import type { RunningReadAgent } from "../runtime/types";
import { formatElapsed } from "./renderers.js";

export const READ_AGENT_IDLE_NUDGE_MS = 60_000;
export const READ_AGENT_HANGING_NUDGE_MS = 180_000;

export type ReadAgentStatusLabel = RunningReadAgent["status"] | "idle" | "hanging";
export type ReadAgentIdleLevel = "none" | "soft" | "hard";

export interface ReadAgentStatusDescription {
  label: ReadAgentStatusLabel;
  detail: string;
  idleLevel: ReadAgentIdleLevel;
  idleMs: number;
}

export type ReadAgentStatusCounts = Partial<Record<ReadAgentStatusLabel, number>>;

export interface ReadAgentStatusSample {
  agent: RunningReadAgent;
  status: ReadAgentStatusDescription;
}

export interface ReadAgentStatusSummary {
  total: number;
  counts: ReadAgentStatusCounts;
  samples: ReadAgentStatusSample[];
}

export interface ReadAgentStatusSummaryOptions {
  now?: number;
  maxDetailed?: number;
}

interface ReadAgentStatusClassification {
  label: ReadAgentStatusLabel;
  idleLevel: ReadAgentIdleLevel;
  idleMs: number;
}

export function buildReadAgentIdleNudgeMessage(agent: RunningReadAgent, status: ReadAgentStatusDescription): string {
  const severity = status.idleLevel === "hard" ? "appears hung" : "has gone quiet";
  const action = status.idleLevel === "hard"
    ? "Ping/check it now, and consider stopping or promoting it if needed."
    : "Ping it or check /team before assuming it is healthy.";
  return `Read agent ${agent.name} on team ${agent.teamName} ${severity}: no response or token change for ${formatElapsed(status.idleMs)}. ${action}`;
}

export function shouldNudgeReadAgentIdle(previousLevel: "soft" | "hard" | undefined, currentLevel: ReadAgentIdleLevel): boolean {
  if (currentLevel === "none") return false;
  if (currentLevel === "hard") return previousLevel !== "hard";
  return previousLevel === undefined;
}

export function describeReadAgentStatus(agent: RunningReadAgent, now = Date.now()): ReadAgentStatusDescription {
  return describeReadAgentStatusFromClassification(agent, classifyReadAgentStatus(agent, now));
}

export function summarizeReadAgentStatuses(
  agents: Iterable<RunningReadAgent>,
  options: ReadAgentStatusSummaryOptions = {}
): ReadAgentStatusSummary {
  const now = options.now ?? Date.now();
  const maxDetailed = Math.max(0, options.maxDetailed ?? Number.POSITIVE_INFINITY);
  const counts: ReadAgentStatusCounts = {};
  const samples: ReadAgentStatusSample[] = [];
  let total = 0;

  for (const agent of agents) {
    const classification = classifyReadAgentStatus(agent, now);
    counts[classification.label] = (counts[classification.label] ?? 0) + 1;
    if (samples.length < maxDetailed) {
      samples.push({
        agent,
        status: describeReadAgentStatusFromClassification(agent, classification),
      });
    }
    total++;
  }

  return { total, counts, samples };
}

function classifyReadAgentStatus(agent: RunningReadAgent, now: number): ReadAgentStatusClassification {
  const lastActivityAt = agent.lastActivityAt || agent.startedAt;
  const idleMs = Math.max(0, now - lastActivityAt);

  if (idleMs >= READ_AGENT_HANGING_NUDGE_MS) {
    return { label: "hanging", idleLevel: "hard", idleMs };
  }

  if (idleMs >= READ_AGENT_IDLE_NUDGE_MS) {
    return { label: "idle", idleLevel: "soft", idleMs };
  }

  return { label: agent.status, idleLevel: "none", idleMs };
}

function describeReadAgentStatusFromClassification(
  agent: RunningReadAgent,
  classification: ReadAgentStatusClassification
): ReadAgentStatusDescription {
  if (classification.idleLevel === "hard") {
    return {
      ...classification,
      detail: `no response/token change for ${formatElapsed(classification.idleMs)} · ping/check now`,
    };
  }

  if (classification.idleLevel === "soft") {
    return {
      ...classification,
      detail: `no response/token change for ${formatElapsed(classification.idleMs)} · consider ping/check`,
    };
  }

  return {
    ...classification,
    detail: describeActiveReadAgentWork(agent),
  };
}

function describeActiveReadAgentWork(agent: RunningReadAgent): string {
  if (agent.status === "starting") return "starting session";
  if (agent.status === "finishing") return "sending report";
  if (agent.status === "working") {
    return agent.activeToolName ? `using ${agent.activeToolName}` : "using tools";
  }
  return "waiting for model response";
}
