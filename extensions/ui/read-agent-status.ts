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
  const lastActivityAt = agent.lastActivityAt || agent.startedAt;
  const idleMs = Math.max(0, now - lastActivityAt);

  if (idleMs >= READ_AGENT_HANGING_NUDGE_MS) {
    return {
      label: "hanging",
      detail: `no response/token change for ${formatElapsed(idleMs)} · ping/check now`,
      idleLevel: "hard",
      idleMs,
    };
  }

  if (idleMs >= READ_AGENT_IDLE_NUDGE_MS) {
    return {
      label: "idle",
      detail: `no response/token change for ${formatElapsed(idleMs)} · consider ping/check`,
      idleLevel: "soft",
      idleMs,
    };
  }

  return {
    label: agent.status,
    detail: describeActiveReadAgentWork(agent),
    idleLevel: "none",
    idleMs,
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
