import * as fs from "node:fs";
import * as path from "node:path";
import * as paths from "../../src/utils/paths";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as teams from "../../src/utils/teams";
import { loadSettings } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import {
  generateExtensionInstanceId,
  readLifecycleTombstone,
  updateMatchingLifecycleTombstone,
  withLifecycleTombstoneLock,
} from "../../src/utils/lifecycle-tombstone";
import {
  requestReadAgentTeardown,
  type NestedSessionShutdownReason,
  type ReadAgentFinalizationResult,
  type ReadAgentTeardownResult,
} from "../agents/read-agent-session-lifecycle";
import { releaseAllClaimsForAgent } from "./roster";
import { cleanupPidFileProcess } from "../internal/session-files";
import { closePersistedRecipient } from "./recipient-closure";

export interface LifecycleRuntimeOptions {
  isTeammate: boolean;
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  renderReadAgentStatus(): void;
  releaseAllClaimsForAgent?(teamName: string, agentName: string): Promise<string[]>;
  drainWriteQueue(teamName: string): Promise<void>;
  getSessionCwd(): string | undefined;
  getTeamName(): string | null | undefined;
  onWriterInactive?(teamName: string, member: Member): void;
  extensionInstanceId?: string;
}

export interface ShutdownTeammateOptions {
  drainQueue?: boolean;
  removeMember?: boolean;
  reason?: unknown;
}

interface ReapedTeammate {
  member: Member;
  reason: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLifecycleRuntime(options: LifecycleRuntimeOptions) {
  let leadWatchdogStarted = false;
  let leadWatchdogTimer: NodeJS.Timeout | null = null;
  let leadWatchdogGeneration = 0;
  const extensionInstanceId = options.extensionInstanceId ?? generateExtensionInstanceId();

  async function finalizeTeammateRuntime(teamName: string, member: Member, expectedRunId: string): Promise<void> {
    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    const pidFileExisted = fs.existsSync(pidFile);
    const pidCleanup = cleanupPidFileProcess(pidFile, { skipPid: process.pid });
    if (pidFileExisted && !pidCleanup.unlinked) {
      throw new Error(`Could not remove pid file for ${member.name}.`);
    }
    const killErrorCode = (pidCleanup.killError as NodeJS.ErrnoException | undefined)?.code;
    if (pidCleanup.killError && killErrorCode !== "ESRCH") {
      throw new Error(`Could not stop pid ${pidCleanup.pid} for ${member.name}: ${errorText(pidCleanup.killError)}`);
    }

    if (member.tmuxPaneId && options.terminal) {
      options.terminal.kill(member.tmuxPaneId);
    }

    if ((member.role ?? "write") === "write") {
      options.onWriterInactive?.(teamName, member);
    }

    const runtimeBeforeDelete = await runtime.readRuntimeStatus(teamName, member.name);
    if (runtimeBeforeDelete?.lifecycleRunId && runtimeBeforeDelete.lifecycleRunId !== expectedRunId) {
      throw new Error(`Runtime status for ${member.name} changed to run ${runtimeBeforeDelete.lifecycleRunId}.`);
    }
    const runtimeDeleted = await runtime.deleteRuntimeStatusUnderLifecycleLock(teamName, member.name, expectedRunId);
    if (runtimeBeforeDelete && !runtimeDeleted) {
      throw new Error(`Could not remove runtime status for ${member.name} run ${expectedRunId}.`);
    }
  }

  function boundedQuarantineResult(
    reason: NestedSessionShutdownReason,
    error: string,
    persistenceClosed = true
  ): ReadAgentTeardownResult {
    return {
      status: "timed_out",
      reason,
      extensionShutdown: "no_handlers",
      abort: "unavailable",
      delivery: "settled",
      dispose: "deferred",
      cancelledDeliveries: 0,
      persistenceClosed,
      finalized: false,
      removedMember: false,
      releasedClaims: [],
      error,
    };
  }

  async function shutdownTeammate(
    teamName: string,
    member: Member,
    shutdownOptions: ShutdownTeammateOptions = {}
  ): Promise<ReadAgentTeardownResult> {
    const reason: NestedSessionShutdownReason = typeof shutdownOptions.reason === "string"
      && ["quit", "reload", "new", "resume", "fork"].includes(shutdownOptions.reason)
      ? shutdownOptions.reason as NestedSessionShutdownReason
      : "quit";
    const baseResult = (): ReadAgentTeardownResult => ({
      status: "settled",
      reason,
      extensionShutdown: "no_handlers",
      abort: "unavailable",
      delivery: "settled",
      dispose: "settled",
      cancelledDeliveries: 0,
      persistenceClosed: true,
      finalized: true,
      removedMember: false,
      releasedClaims: [],
    });
    if (member.name === "team-lead") return baseResult();

    const drainQueue = shutdownOptions.drainQueue ?? true;
    const removeMember = shutdownOptions.removeMember ?? true;
    const key = options.readAgentKey(teamName, member.name);
    const expectedState = options.runningReadAgents.get(key);
    let expectedRunId = member.lifecycleRunId;
    if (!expectedRunId) {
      try {
        expectedRunId = await teams.ensureMemberLifecycleRunId(teamName, member.name, expectedState?.runId);
      } catch (error) {
        if (!expectedState) throw error;
        expectedRunId = expectedState.runId;
      }
      member.lifecycleRunId = expectedRunId;
    }

    const persistedRuntime = await runtime.readRuntimeStatus(teamName, member.name).catch(() => null);
    if (persistedRuntime?.lifecycleRunId && persistedRuntime.lifecycleRunId !== expectedRunId) {
      return boundedQuarantineResult(
        reason,
        `Refusing lifecycle cleanup for ${member.name}: runtime status belongs to run ${persistedRuntime.lifecycleRunId}, not ${expectedRunId}.`
      );
    }
    if (persistedRuntime && !persistedRuntime.lifecycleRunId) {
      try {
        await runtime.writeRuntimeStatus(teamName, member.name, expectedRunId, {});
      } catch (error) {
        await withLifecycleTombstoneLock(teamName, member.name, async lifecycleLock => {
          lifecycleLock.occupy({
            team: teamName,
            agent: member.name,
            runId: expectedRunId,
            role: (member.role ?? "write") === "read" ? "read" : "write",
            reason,
            extensionInstanceId,
          });
          lifecycleLock.updateMatching(expectedRunId, { phase: "cleanup_failed", error: errorText(error) });
        });
        return boundedQuarantineResult(
          reason,
          `Could not persist lifecycle run identity for ${member.name}: ${errorText(error)}`,
          false
        );
      }
    }

    if (expectedState && expectedState.runId !== expectedRunId) {
      return boundedQuarantineResult(
        reason,
        `Refusing lifecycle cleanup for ${member.name}: runtime run ${expectedState.runId} does not match persisted run ${expectedRunId}.`
      );
    }

    const existingFence = await readLifecycleTombstone(teamName, member.name);
    if (existingFence.status === "corrupt") {
      return boundedQuarantineResult(reason, existingFence.error, false);
    }
    if (existingFence.status === "occupied" && existingFence.tombstone.runId !== expectedRunId) {
      return boundedQuarantineResult(
        reason,
        `Agent ${member.name} is quarantined for different run ${existingFence.tombstone.runId}.`
      );
    }
    if (!expectedState && existingFence.status === "occupied") {
      return boundedQuarantineResult(
        reason,
        `Agent ${member.name} remains quarantined for run ${existingFence.tombstone.runId} (${existingFence.tombstone.phase}).`
      );
    }

    const releaseClaims = options.releaseAllClaimsForAgent ?? releaseAllClaimsForAgent;
    const finalize = async (): Promise<ReadAgentFinalizationResult> => {
      let releasedClaims: string[] = [];
      let removedMember = false;
      let staleFence = false;
      let cleanupError: unknown;

      await withLifecycleTombstoneLock(teamName, member.name, async lifecycleLock => {
        const fence = lifecycleLock.read();
        if (
          fence.status !== "occupied"
          || fence.tombstone.runId !== expectedRunId
        ) {
          staleFence = true;
          if (expectedState && options.runningReadAgents.get(key) === expectedState) {
            options.runningReadAgents.delete(key);
          }
          return;
        }

        if (expectedState && !options.isCurrentReadAgentRun(key, expectedState)) {
          staleFence = true;
          return;
        }

        lifecycleLock.updateMatching(expectedRunId, { phase: "finalizing", error: undefined });
        try {
          const config = teams.teamExists(teamName) ? await teams.readConfig(teamName) : null;
          const currentMember = config?.members.find(item => item.name === member.name);
          if (currentMember && currentMember.lifecycleRunId !== expectedRunId) {
            staleFence = true;
            return;
          }

          releasedClaims = await releaseClaims(teamName, member.name);
          await finalizeTeammateRuntime(teamName, currentMember ?? member, expectedRunId);

          if (removeMember) {
            if (teams.teamExists(teamName) && currentMember) {
              await teams.removeMemberMatchingRun(teamName, member.name, expectedRunId);
              const afterRemoval = await teams.readConfig(teamName);
              const retained = afterRemoval.members.find(item => item.name === member.name);
              if (retained) {
                if (retained.lifecycleRunId !== expectedRunId) {
                  staleFence = true;
                  return;
                }
                throw new Error(`Member ${member.name} remained in ${teamName} after removal.`);
              }
              removedMember = true;
            } else {
              removedMember = true;
            }
          }

          // Preserve historical failure reporting while the fence is still held.
          // A second drain after matching clear starts any item blocked by this name.
          if (drainQueue && (member.role ?? "write") === "write") {
            await options.drainWriteQueue(teamName);
          }

          if (expectedState && options.runningReadAgents.get(key) === expectedState) {
            options.runningReadAgents.delete(key);
          }
          options.renderReadAgentStatus();
          if (!lifecycleLock.clearMatching(expectedRunId)) {
            throw new Error(`Lifecycle tombstone for ${member.name} changed before final clear.`);
          }
        } catch (error) {
          cleanupError = error;
          lifecycleLock.updateMatching(expectedRunId, { phase: "cleanup_failed", error: errorText(error) });
        }
      });

      if (staleFence) {
        return {
          finalized: false,
          removedMember: false,
          releasedClaims: [],
          error: `Skipped stale finalizer for ${member.name}; lifecycle ownership changed.`,
        };
      }
      if (cleanupError) {
        return {
          finalized: false,
          removedMember,
          releasedClaims,
          error: errorText(cleanupError),
        };
      }

      if (drainQueue && (member.role ?? "write") === "write") {
        void options.drainWriteQueue(teamName).catch(() => {});
      }
      return { finalized: true, removedMember, releasedClaims };
    };

    const closePersistence = async (): Promise<void> => {
      if (expectedState) {
        if (!expectedState.recipientClosurePromise) {
          expectedState.recipientClosurePromise = closePersistedRecipient(
            teamName,
            member.name,
            expectedRunId,
            {
              removeOnFailure: true,
              role: (member.role ?? "write") === "read" ? "read" : "write",
              reason,
              extensionInstanceId,
            }
          ).then(() => { expectedState.persistedRecipientClosed = true; });
        }
        await expectedState.recipientClosurePromise;
        return;
      }
      await closePersistedRecipient(teamName, member.name, expectedRunId, {
        removeOnFailure: true,
        role: (member.role ?? "write") === "read" ? "read" : "write",
        reason,
        extensionInstanceId,
      });
    };

    if (expectedState) {
      return requestReadAgentTeardown(expectedState, {
        reason,
        closePersistence,
        finalize,
        onBoundedResult: async result => {
          const phase = result.status === "timed_out" ? "timed_out" : "cleanup_failed";
          await updateMatchingLifecycleTombstone(teamName, member.name, expectedRunId, {
            phase,
            ...(result.status === "timed_out" ? {
              timeout: { afterMs: 2500, at: Date.now() },
            } : {}),
            error: result.error,
          });
        },
      });
    }

    try {
      await closePersistence();
    } catch (error) {
      return {
        ...baseResult(),
        status: "persistence_failed",
        dispose: "deferred",
        persistenceClosed: false,
        finalized: false,
        error: errorText(error),
      };
    }
    const finalization = await finalize();
    return {
      ...baseResult(),
      status: finalization.finalized && !finalization.error ? "settled" : "cleanup_failed",
      ...finalization,
    };
  }

  async function killTeammate(teamName: string, member: Member): Promise<ReadAgentTeardownResult> {
    return shutdownTeammate(teamName, member, { drainQueue: false });
  }

  function teammateRuntimeIsStale(status: runtime.AgentRuntimeStatus | null, maxAgeMs: number, now = Date.now()): boolean {
    if (!status) return false;
    const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
    return lastActivity > 0 && (now - lastActivity) > maxAgeMs;
  }

  async function readRuntimeStatusByMember(teamName: string, members: Member[]): Promise<Map<string, runtime.AgentRuntimeStatus | null>> {
    const entries = await Promise.all(members.map(async (member) => {
      const status = await runtime.readRuntimeStatus(teamName, member.name);
      return [member.name, status] as const;
    }));
    return new Map(entries);
  }

  async function flushReapedTeammates(teamName: string, reaped: ReapedTeammate[]): Promise<void> {
    if (reaped.length === 0) return;

    if (reaped.some(({ member }) => (member.role ?? "write") === "write")) {
      await options.drainWriteQueue(teamName);
    }

    await Promise.all(reaped.map(({ member, reason }) => messaging.sendPlainMessage(
      teamName,
      "watchdog",
      "team-lead",
      `Reaped ${member.name}: ${reason}`,
      `Watchdog reaped ${member.name}`,
      "yellow"
    )));
  }

  async function runWatchdogOnce(targetTeamName: string, shouldContinue: () => boolean = () => true): Promise<void> {
    const settings = loadSettings({ projectDir: options.getSessionCwd() || process.cwd() });
    const staleMs = runtime.HEARTBEAT_STALE_MS + settings.watchdog.bufferSeconds * 1000;
    const now = Date.now();
    const config = await teams.readConfig(targetTeamName);
    const members = config.members.filter((member) => member.name !== "team-lead");
    const runtimeStatusByMember = await readRuntimeStatusByMember(targetTeamName, members);
    const reaped: ReapedTeammate[] = [];

    try {
      for (const member of members) {
        if (!shouldContinue()) return;
        const fence = await readLifecycleTombstone(targetTeamName, member.name);
        if (fence.status !== "absent") continue;

        const role = member.role ?? "write";
        const runtimeStatus = runtimeStatusByMember.get(member.name) ?? null;
        const runtimeStale = teammateRuntimeIsStale(runtimeStatus, staleMs, now);
        const key = options.readAgentKey(targetTeamName, member.name);
        const inProcessAlive = options.runningReadAgents.has(key);

        if (runtimeStale && !inProcessAlive) {
          const result = await shutdownTeammate(targetTeamName, member, { drainQueue: false });
          if (result.status === "settled" && result.finalized) {
            reaped.push({ member, reason: `${role}-agent heartbeat is stale and no in-process session is running` });
          }
          continue;
        }

        const legacyPaneAlive = !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId));
        if (!inProcessAlive && member.tmuxPaneId && !legacyPaneAlive) {
          const result = await shutdownTeammate(targetTeamName, member, { drainQueue: false });
          if (result.status === "settled" && result.finalized) {
            reaped.push({ member, reason: "legacy tmux screen is gone" });
          }
        }
      }
    } finally {
      await flushReapedTeammates(targetTeamName, reaped);
    }

    if (shouldContinue()) await runtime.cleanupStaleRuntimeFiles(targetTeamName);
  }

  function stopLeadWatchdog(): void {
    leadWatchdogGeneration += 1;
    if (leadWatchdogTimer) clearInterval(leadWatchdogTimer);
    leadWatchdogTimer = null;
    leadWatchdogStarted = false;
  }

  function startLeadWatchdog() {
    if (leadWatchdogStarted || options.isTeammate || !options.getSessionCwd()) return;
    leadWatchdogStarted = true;
    const generation = ++leadWatchdogGeneration;
    leadWatchdogTimer = setInterval(async () => {
      if (generation !== leadWatchdogGeneration) return;
      const teamName = options.getTeamName();
      if (!teamName) return;
      try {
        await runWatchdogOnce(teamName, () => generation === leadWatchdogGeneration);
      } catch {
        // Keep watchdog quiet; health is visible via /team and inbox messages on actual reaps.
      }
    }, 30000);
  }

  return { killTeammate, shutdownTeammate, runWatchdogOnce, startLeadWatchdog, stopLeadWatchdog };
}
