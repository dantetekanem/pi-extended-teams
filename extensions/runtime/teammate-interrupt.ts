import type { TerminalAdapter } from "../../src/utils/terminal-adapter.js";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "./types.js";
export const DEFAULT_INTERRUPT_SETTLE_TIMEOUT_MS = 1_500;
export type TeammateInterruptStatus =
  | "interrupted" | "interrupt_sent" | "no_command" | "not_found" | "pending" | "unsupported" | "failed";
export interface TeammateInterruptResult {
  status: TeammateInterruptStatus;
  agentName: string;
  message: string;
  agentKind?: "read" | "write";
  lifecycleRunId?: string;
  mechanism?: "agent-session-abort" | "tmux-escape";
  reason?: "no-active-session" | "session-not-created" | "lifecycle-closing"
    | "missing-pane" | "missing-runtime-proof" | "terminal-interrupt-unavailable";
  error?: string;
}
export interface TeammateInterrupterOptions {
  terminal: Pick<TerminalAdapter, "interrupt"> | null | undefined;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  getTeamName(): string | null | undefined;
  settleTimeoutMs?: number;
}

type ResultFields = Omit<TeammateInterruptResult, "status" | "agentName" | "message">;
type InterruptTeammate = (agentName: string) => Promise<TeammateInterruptResult>;

function result(status: TeammateInterruptStatus, agentName: string, message: string, fields: ResultFields = {}): TeammateInterruptResult {
  return { status, agentName, message, ...fields };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeMember(members: Member[], agentName: string): Member | undefined {
  return members.find(member => member.name === agentName && member.name !== "team-lead" && member.isActive !== false);
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<"settled" | "timed_out" | unknown> {
  let timeout: NodeJS.Timeout | undefined;
  const observed = operation.then<"settled", unknown>(() => "settled", error => error);
  const timedOut = new Promise<"timed_out">((resolve) => {
    timeout = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs));
  });
  const outcome = await Promise.race([observed, timedOut]);
  if (timeout) clearTimeout(timeout);
  return outcome;
}

function readLifecycleClosing(state: RunningReadAgent): boolean {
  return state.stopRequested === true
    || state.messageDeliveryClosed === true
    || ["stopping", "quarantined", "persistence_failed", "finalized"].includes(state.teardownState || "");
}

async function interruptReadAgent(
  state: RunningReadAgent, member: Member, options: TeammateInterrupterOptions,
): Promise<TeammateInterruptResult> {
  const fields = { agentKind: "read" as const, lifecycleRunId: state.runId };
  if (member.lifecycleRunId !== state.runId || readLifecycleClosing(state)) {
    return result("unsupported", state.name, `Cannot interrupt ${state.name}: its lifecycle is closing or has been replaced.`, {
      ...fields, reason: "lifecycle-closing",
    });
  }
  if (!state.session) {
    return result("unsupported", state.name, `Cannot interrupt ${state.name}: its nested session has not started.`, {
      ...fields, reason: "session-not-created",
    });
  }

  const generation = state.activeOperationGeneration;
  const toolName = state.activeToolName?.trim();
  if (!generation || !toolName || state.status !== "working" || !state.session.isStreaming) {
    return result("no_command", state.name, `Agent ${state.name} has no running tool command to interrupt.`, fields);
  }
  if (state.operationInterruptPromise) {
    return result("pending", state.name, `An interrupt is already pending for ${state.name}'s running ${toolName} command.`, fields);
  }

  const operationSettlement = state.activeOperationSettlementPromise;
  if (!operationSettlement) {
    return result("no_command", state.name, `Agent ${state.name} has no running tool command to interrupt.`, fields);
  }

  state.interruptRequestedGeneration = generation;
  let nativeAbort: Promise<void>;
  try {
    nativeAbort = Promise.resolve(state.session.abort());
  } catch (error) {
    if (state.interruptRequestedGeneration === generation) state.interruptRequestedGeneration = undefined;
    const message = errorText(error);
    return result("failed", state.name, `Could not interrupt ${state.name}'s running ${toolName} command: ${message}`, {
      ...fields, error: message,
    });
  }
  const operation = Promise.allSettled([nativeAbort, operationSettlement]).then((results) => {
    const failedAbort = results[0];
    if (failedAbort.status === "rejected") throw failedAbort.reason;
  });

  state.operationInterruptPromise = operation;
  void operation.then(
    () => { if (state.operationInterruptPromise === operation) state.operationInterruptPromise = undefined; },
    () => {
      if (state.operationInterruptPromise === operation) state.operationInterruptPromise = undefined;
      if (state.interruptRequestedGeneration === generation) state.interruptRequestedGeneration = undefined;
    },
  );

  const outcome = await settleWithin(operation, options.settleTimeoutMs ?? DEFAULT_INTERRUPT_SETTLE_TIMEOUT_MS);
  if (outcome === "timed_out") {
    return result("pending", state.name, `Sent an interrupt to ${state.name}'s running ${toolName} command, but cooperative cancellation is still pending. The agent was not stopped.`, fields);
  }
  if (outcome !== "settled") {
    const message = errorText(outcome);
    return result("failed", state.name, `Could not interrupt ${state.name}'s running ${toolName} command: ${message}`, {
      ...fields, error: message,
    });
  }

  const sameState = options.runningReadAgents.get(options.readAgentKey(state.teamName, state.name)) === state;
  if (!sameState || state.runId !== fields.lifecycleRunId) {
    const message = "The target lifecycle changed while the interrupt was settling.";
    return result("failed", state.name, `The command interrupt settled, but ${state.name}'s lifecycle changed before it could be confirmed.`, {
      ...fields, error: message,
    });
  }
  return result("interrupted", state.name, `Interrupted ${state.name}'s running ${toolName} command. The agent is still active and can receive a follow-up message.`, {
    ...fields, mechanism: "agent-session-abort",
  });
}

async function interruptWriter(
  teamName: string, member: Member, options: TeammateInterrupterOptions,
): Promise<TeammateInterruptResult> {
  const fields = { agentKind: "write" as const, lifecycleRunId: member.lifecycleRunId };
  if (!member.lifecycleRunId) {
    return result("unsupported", member.name, `Cannot interrupt ${member.name}: its lifecycle identity is unavailable.`, {
      ...fields, reason: "missing-runtime-proof",
    });
  }
  if (!member.tmuxPaneId) {
    return result("unsupported", member.name, `Cannot interrupt ${member.name}: it has no tmux pane.`, {
      ...fields, reason: "missing-pane",
    });
  }
  if (typeof options.terminal?.interrupt !== "function") {
    return result("unsupported", member.name, `Cannot interrupt ${member.name}: the terminal adapter cannot send Pi's interrupt key.`, {
      ...fields, reason: "terminal-interrupt-unavailable",
    });
  }

  const [latestConfig, latestRuntime] = await Promise.all([
    teams.readConfig(teamName),
    runtime.readRuntimeStatus(teamName, member.name).catch(() => null),
  ]);
  const latestMember = activeMember(latestConfig.members, member.name);
  const heartbeatRecent = !!latestRuntime?.lastHeartbeatAt
    && Date.now() - latestRuntime.lastHeartbeatAt <= runtime.HEARTBEAT_STALE_MS;
  if (!latestMember
    || latestMember.lifecycleRunId !== member.lifecycleRunId
    || latestMember.tmuxPaneId !== member.tmuxPaneId
    || latestRuntime?.lifecycleRunId !== member.lifecycleRunId
    || latestRuntime.ready !== true
    || !heartbeatRecent) {
    return result("unsupported", member.name, `Cannot interrupt ${member.name}: current runtime proof does not match its active lifecycle.`, {
      ...fields, reason: "missing-runtime-proof",
    });
  }

  const toolName = latestRuntime.activeToolName?.trim();
  if (latestRuntime.currentAction !== "working" || !toolName) {
    return result("no_command", member.name, `Agent ${member.name} has no running tool command to interrupt.`, fields);
  }

  try {
    if (!options.terminal.interrupt(member.tmuxPaneId)) {
      const message = "tmux rejected the interrupt key.";
      return result("failed", member.name, `Could not send Pi's Escape interrupt to ${member.name}'s running ${toolName} command. The agent was not stopped.`, {
        ...fields, error: message,
      });
    }
  } catch (error) {
    const message = errorText(error);
    return result("failed", member.name, `Could not send Pi's Escape interrupt to ${member.name}'s running ${toolName} command: ${message}`, {
      ...fields, error: message,
    });
  }
  return result("interrupt_sent", member.name, `Sent Pi's Escape interrupt to ${member.name}'s running ${toolName} command. tmux accepted the key; command settlement is not confirmed.`, {
    ...fields, mechanism: "tmux-escape",
  });
}

export function createTeammateInterrupter(options: TeammateInterrupterOptions): InterruptTeammate {
  return async (agentNameInput: string): Promise<TeammateInterruptResult> => {
    const agentName = agentNameInput.trim();
    const teamName = options.getTeamName();
    if (!teamName) return result("unsupported", agentName, "No active agent session is available to interrupt.", { reason: "no-active-session" });

    try {
      const config = await teams.readConfig(teamName);
      const member = activeMember(config.members, agentName);
      if (!member) return result("not_found", agentName, `Agent ${agentName} is not active in this session.`);

      const state = options.runningReadAgents.get(options.readAgentKey(teamName, agentName));
      if (state) return interruptReadAgent(state, member, options);
      if (member.role === "write") return interruptWriter(teamName, member, options);
      return result("unsupported", agentName, `Cannot interrupt ${agentName}: no live in-process session is available.`, {
        agentKind: "read",
        lifecycleRunId: member.lifecycleRunId,
        reason: "session-not-created",
      });
    } catch (error) {
      const message = errorText(error);
      return result("failed", agentName, `Could not interrupt ${agentName}: ${message}`, { error: message });
    }
  };
}
