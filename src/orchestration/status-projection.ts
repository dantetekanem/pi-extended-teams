import type { Member } from "../utils/models";
import type { LifecycleTombstoneReadResult } from "../utils/lifecycle-tombstone";
import { isHeartbeatFresh, STARTUP_STALL_MS, type AgentRuntimeStatus } from "../utils/runtime";

export const AGENT_HANGING_MS = 15 * 60_000;

export type ActiveAgentPhase = "starting" | "thinking" | "working" | "finishing"
  | "stalled" | "stopping" | "quarantined" | "persistence-failed";

export interface AgentActivity {
  runId: string;
  status: "starting" | "thinking" | "working" | "finishing";
  startedAt: number;
  role?: string;
  lastActivityAt?: number;
  teardownState?: string;
  handoffDetached?: boolean;
  latestProgress?: string;
  progressUpdatedAt?: number;
  activeToolName?: string;
  lastError?: { message: string };
}

export function isAgentActivity(value: unknown): value is AgentActivity {
  return typeof value === "object" && value !== null
    && "runId" in value && typeof value.runId === "string"
    && "startedAt" in value && typeof value.startedAt === "number"
    && "status" in value && typeof value.status === "string"
    && ["starting", "thinking", "working", "finishing"].includes(value.status);
}

function lifecyclePhase(member: Member, fence: LifecycleTombstoneReadResult): { phase: ActiveAgentPhase; error?: string } | undefined {
  if (fence.status === "absent") return;
  if (fence.status === "corrupt") return { phase: "quarantined", error: fence.error };
  const { tombstone } = fence;
  const mismatch = member.lifecycleRunId && tombstone.runId !== member.lifecycleRunId
    ? `Lifecycle fence belongs to run ${tombstone.runId}, not roster run ${member.lifecycleRunId}.`
    : undefined;
  return {
    phase: tombstone.phase === "cleanup_failed" || tombstone.phase === "timed_out" ? "quarantined" : "stopping",
    error: mismatch || tombstone.error,
  };
}

export function projectAgentStatus(input: {
  member: Member;
  activity?: AgentActivity;
  runtime: AgentRuntimeStatus | null;
  fence: LifecycleTombstoneReadResult;
  terminalAlive: boolean | null;
  now: number;
  unreadCount?: number;
}) {
  const { member, now } = input;
  const state = input.activity?.runId === member.lifecycleRunId ? input.activity : undefined;
  const runtime = input.runtime?.lifecycleRunId === member.lifecycleRunId ? input.runtime : null;
  const persisted = lifecyclePhase(member, input.fence);
  const hasRecentHeartbeat = isHeartbeatFresh(runtime, now);
  const inProcess = !!state && state.teardownState !== "finalized" && !state.handoffDetached;
  const externalAlive = member.isActive !== false && (hasRecentHeartbeat || input.terminalAlive === true);
  const alive = inProcess || externalAlive ? true
    : member.isActive === false || input.terminalAlive === false || member.role === "read" ? false : null;
  const startupStalled = alive === true && (input.unreadCount ?? 0) > 0
    && now - member.joinedAt > STARTUP_STALL_MS && !runtime?.ready;
  const teardownPhase = state?.teardownState === "persistence_failed" ? "persistence-failed"
    : state?.teardownState === "quarantined" ? "quarantined"
      : state?.teardownState === "stopping" ? "stopping" : undefined;
  const fencedPhase = teardownPhase ?? persisted?.phase;
  let phase: ActiveAgentPhase;
  if (fencedPhase) phase = fencedPhase;
  else if (inProcess) phase = now - (state.lastActivityAt || state.startedAt) >= AGENT_HANGING_MS ? "stalled" : state.status;
  else if (!externalAlive) phase = member.isActive !== false && !runtime?.ready && now - member.joinedAt <= STARTUP_STALL_MS ? "starting" : "stalled";
  else phase = runtime?.currentAction === "done" ? "finishing" : runtime?.currentAction ?? (runtime?.ready ? "working" : "starting");

  const health = fencedPhase === "quarantined" ? "quarantined"
    : fencedPhase === "persistence-failed" ? "persistence-failed"
      : fencedPhase ? "stopping"
        : startupStalled || (phase === "stalled" && alive) ? "stalled"
          : alive === null ? "unknown"
            : !alive ? "dead"
              : runtime?.ready ? hasRecentHeartbeat ? "healthy" : "idle"
                : inProcess && state.status !== "starting" ? "healthy" : "starting";
  return {
    phase, alive, health, hasRecentHeartbeat, startupStalled,
    agentLoopReady: !fencedPhase && alive === true && (!!runtime?.ready || (inProcess && state.status !== "starting")),
    state, runtime,
    error: persisted?.error || state?.lastError?.message || runtime?.lastError?.message,
  };
}
