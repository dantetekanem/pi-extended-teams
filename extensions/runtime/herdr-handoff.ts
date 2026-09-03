import { randomUUID } from "node:crypto";
import type { AgentRuntimeStatus } from "../../src/utils/runtime.js";
import type { HerdrOwnerPublicationResult } from "../../src/utils/teams.js";
import { execCommand } from "../../src/utils/terminal-adapter.js";
import type { ReadAgentHandoffResult, RunningReadAgent } from "./types.js";

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: unknown;
}

interface HerdrCommandOptions {
  timeoutMs: number;
}

export interface HerdrPaneControllerOptions {
  env?: Record<string, string | undefined>;
  run?(command: string, args: string[], options: HerdrCommandOptions): CommandResult;
  commandTimeoutMs?: number;
}

export interface CreateHerdrAgentPaneOptions {
  cwd: string;
  teamName: string;
  agentName: string;
  lifecycleRunId: string;
  processIdentity: string;
}

export interface HerdrPaneController {
  isAvailable(): boolean;
  createAgentPane(options: CreateHerdrAgentPaneOptions): string;
  startAgent(paneId: string, resumeCommand: string): void;
  isPaneAlive(paneId: string): boolean;
  closePane(paneId: string): void;
}

function commandError(action: string, result: CommandResult): Error {
  const processError = result.error instanceof Error ? result.error.message : "";
  const detail = result.stderr.trim() || result.stdout.trim() || processError || `exit status ${String(result.status)}`;
  return new Error(`Herdr ${action} failed: ${detail}`);
}

export function createHerdrPaneController(options: HerdrPaneControllerOptions = {}): HerdrPaneController {
  const env = options.env ?? process.env;
  const run = options.run ?? execCommand;
  const binary = env.HERDR_BIN_PATH || "herdr";
  const currentPaneId = env.HERDR_PANE_ID?.trim();
  const commandOptions = { timeoutMs: options.commandTimeoutMs ?? 5_000 };

  const isAvailable = () => env.HERDR_ENV === "1"
    && !!env.HERDR_SOCKET_PATH?.trim()
    && !!currentPaneId;
  const isPaneAlive = (paneId: string): boolean => {
    const result = run(binary, ["pane", "list"], commandOptions);
    if (result.status !== 0) throw commandError("pane liveness check", result);
    let panes: unknown;
    try {
      panes = JSON.parse(result.stdout)?.result?.panes;
    } catch {
      throw new Error("Herdr pane liveness check returned invalid JSON.");
    }
    if (!Array.isArray(panes)) throw new Error("Herdr pane liveness check returned no pane list.");
    return panes.some(pane => pane?.pane_id === paneId);
  };

  return {
    isAvailable,
    createAgentPane(input) {
      if (!isAvailable()) throw new Error("Cannot move an agent: this Pi session is not running inside Herdr.");
      const result = run(binary, [
        "pane", "split", currentPaneId!,
        "--direction", "right",
        "--cwd", input.cwd,
        "--env", `PI_TEAM_NAME=${input.teamName}`,
        "--env", `PI_AGENT_NAME=${input.agentName}`,
        "--env", `PI_LIFECYCLE_RUN_ID=${input.lifecycleRunId}`,
        "--env", `PI_AGENT_PROCESS_IDENTITY=${input.processIdentity}`,
        "--focus",
      ], commandOptions);
      if (result.status !== 0) throw commandError("pane creation", result);

      let paneId: unknown;
      try {
        paneId = JSON.parse(result.stdout)?.result?.pane?.pane_id;
      } catch {
        throw new Error("Herdr pane creation returned invalid JSON.");
      }
      if (typeof paneId !== "string" || !paneId.trim()) {
        throw new Error("Herdr pane creation did not return a pane id.");
      }
      return paneId;
    },
    startAgent(paneId, resumeCommand) {
      const result = run(binary, ["pane", "run", paneId, `exec ${resumeCommand}`], commandOptions);
      if (result.status !== 0) throw commandError(`agent start in pane ${paneId}`, result);
    },
    isPaneAlive,
    closePane(paneId) {
      if (!paneId || !isPaneAlive(paneId)) return;
      const result = run(binary, ["pane", "close", paneId], commandOptions);
      if (result.status === 0) return;
      try {
        if (!isPaneAlive(paneId)) return;
      } catch {
        // Preserve the close error when liveness cannot be confirmed.
      }
      throw commandError("pane close", result);
    },
  };
}

export interface WaitForExternalAgentReadyInput {
  teamName: string;
  agentName: string;
  lifecycleRunId: string;
  startedAfter: number;
  paneId: string;
  processIdentity: string;
  expectedPid?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ExternalAgentReadyDependencies {
  readStatus(teamName: string, agentName: string): Promise<AgentRuntimeStatus | null>;
  isProcessAlive(pid: number): boolean;
  isPaneAlive(paneId: string): boolean;
  processPid?: number;
  now?(): number;
  pause?(milliseconds: number): Promise<void>;
}

export async function waitForExternalAgentReady(
  input: WaitForExternalAgentReadyInput,
  dependencies: ExternalAgentReadyDependencies,
): Promise<AgentRuntimeStatus> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;

  while (true) {
    let status: AgentRuntimeStatus | null = null;
    try {
      status = await dependencies.readStatus(input.teamName, input.agentName);
    } catch {
      // The runtime file may be between atomic lifecycle updates while Pi starts.
    }
    const externalPid = status?.pid;
    const candidateReady = status?.lifecycleRunId === input.lifecycleRunId
      && status.ready === true
      && status.paneId === input.paneId
      && status.processIdentity === input.processIdentity
      && typeof externalPid === "number"
      && externalPid !== (dependencies.processPid ?? process.pid)
      && (input.expectedPid === undefined || externalPid === input.expectedPid)
      && typeof status.startedAt === "number"
      && status.startedAt >= input.startedAfter
      && dependencies.isProcessAlive(externalPid);
    if (candidateReady && status) {
      try {
        if (dependencies.isPaneAlive(input.paneId)) return status;
      } catch {
        // A transient Herdr CLI failure is not proof that the pane is dead.
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`Agent ${input.agentName} did not become ready in Herdr within ${timeoutMs}ms.`);
    }
    await pause(Math.min(pollIntervalMs, remaining));
  }
}

export interface ReadAgentHerdrHandoffInput {
  teamName: string;
  agentName: string;
  lifecycleRunId: string;
  cwd: string;
  state: RunningReadAgent;
}

export interface ReadAgentHerdrHandoffDependencies {
  controller: HerdrPaneController;
  detach(): Promise<ReadAgentHandoffResult>;
  detachTimeoutMs?: number;
  queueMessage(): Promise<void>;
  publishPendingOwner(paneId: string, processIdentity: string): Promise<boolean>;
  waitForReady(input: WaitForExternalAgentReadyInput): Promise<AgentRuntimeStatus>;
  publishExternalOwner(paneId: string): Promise<HerdrOwnerPublicationResult>;
  removeInProcessState(): void;
  createProcessIdentity?(): string;
  now?(): number;
}

function clearExternalHandoffProof(state: RunningReadAgent): void {
  state.handoffPaneId = undefined;
  state.handoffExternalPid = undefined;
  state.handoffExternalStartedAt = undefined;
  state.handoffProcessIdentity = undefined;
  state.handoffExternalReady = undefined;
}

export function waitForReadAgentDetach(
  agentName: string,
  detach: Promise<ReadAgentHandoffResult>,
  timeoutMs = 3_000,
): Promise<ReadAgentHandoffResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent ${agentName} did not detach within ${timeoutMs}ms; retry after its current command settles.`));
    }, timeoutMs);
    detach.then(
      result => { clearTimeout(timeout); resolve(result); },
      error => { clearTimeout(timeout); reject(error); },
    );
  });
}

async function publishExternalOwner(
  input: ReadAgentHerdrHandoffInput,
  dependencies: ReadAgentHerdrHandoffDependencies,
  paneId: string,
): Promise<void> {
  const publication = await dependencies.publishExternalOwner(paneId);
  if (publication === "published" || publication === "finalizing") {
    dependencies.removeInProcessState();
    return;
  }

  dependencies.controller.closePane(paneId);
  clearExternalHandoffProof(input.state);
  dependencies.removeInProcessState();
  throw new Error(`Agent ${input.agentName} lifecycle ownership changed before Herdr publication.`);
}

async function runReadAgentHerdrHandoff(
  input: ReadAgentHerdrHandoffInput,
  dependencies: ReadAgentHerdrHandoffDependencies,
): Promise<void> {
  const { state } = input;
  const now = dependencies.now ?? Date.now;

  if (state.handoffPaneId && !state.handoffExternalReady) {
    dependencies.controller.closePane(state.handoffPaneId);
    clearExternalHandoffProof(state);
  }

  if (state.handoffExternalReady
    && state.handoffPaneId
    && state.handoffExternalPid
    && state.handoffExternalStartedAt !== undefined
    && state.handoffProcessIdentity) {
    let externalStillReady = false;
    try {
      await dependencies.waitForReady({
        teamName: input.teamName,
        agentName: input.agentName,
        lifecycleRunId: input.lifecycleRunId,
        startedAfter: state.handoffExternalStartedAt,
        paneId: state.handoffPaneId,
        processIdentity: state.handoffProcessIdentity,
        expectedPid: state.handoffExternalPid,
      });
      externalStillReady = true;
    } catch {
      dependencies.controller.closePane(state.handoffPaneId);
      clearExternalHandoffProof(state);
    }
    if (externalStillReady) {
      await publishExternalOwner(input, dependencies, state.handoffPaneId!);
      return;
    }
  }

  const handoff = await waitForReadAgentDetach(
    input.agentName,
    dependencies.detach(),
    dependencies.detachTimeoutMs,
  );
  if (handoff.status !== "ready") {
    throw new Error(handoff.error || `Could not detach ${input.agentName} for Herdr.`);
  }
  const resumeCommand = handoff.resumeCommand ?? state.handoffResumeCommand;
  if (!resumeCommand) throw new Error(`Agent ${input.agentName} has no resumable Pi command.`);

  const processIdentity = (dependencies.createProcessIdentity ?? randomUUID)();
  const paneId = dependencies.controller.createAgentPane({
    cwd: input.cwd,
    teamName: input.teamName,
    agentName: input.agentName,
    lifecycleRunId: input.lifecycleRunId,
    processIdentity,
  });
  state.handoffPaneId = paneId;
  let externalReady = false;
  try {
    const pendingPublished = await dependencies.publishPendingOwner(paneId, processIdentity);
    if (!pendingPublished) {
      throw new Error(`Agent ${input.agentName} lifecycle ownership changed before Herdr launch.`);
    }
    await dependencies.queueMessage();
    const startedAfter = now();
    dependencies.controller.startAgent(paneId, resumeCommand);
    const status = await dependencies.waitForReady({
      teamName: input.teamName,
      agentName: input.agentName,
      lifecycleRunId: input.lifecycleRunId,
      startedAfter,
      paneId,
      processIdentity,
    });
    if (typeof status.pid !== "number" || typeof status.startedAt !== "number") {
      throw new Error(`Agent ${input.agentName} returned an incomplete Herdr readiness acknowledgement.`);
    }

    externalReady = true;
    state.handoffExternalPid = status.pid;
    state.handoffExternalStartedAt = status.startedAt;
    state.handoffProcessIdentity = processIdentity;
    state.handoffExternalReady = true;
    await publishExternalOwner(input, dependencies, paneId);
  } catch (error) {
    if (!externalReady) {
      dependencies.controller.closePane(paneId);
      clearExternalHandoffProof(state);
    }
    throw error;
  }
}

export function performReadAgentHerdrHandoff(
  input: ReadAgentHerdrHandoffInput,
  dependencies: ReadAgentHerdrHandoffDependencies,
): Promise<void> {
  const { state } = input;
  if (state.handoffTransactionPromise) return state.handoffTransactionPromise;

  let transaction!: Promise<void>;
  transaction = runReadAgentHerdrHandoff(input, dependencies).finally(() => {
    if (state.handoffTransactionPromise === transaction) state.handoffTransactionPromise = undefined;
  });
  state.handoffTransactionPromise = transaction;
  return transaction;
}
