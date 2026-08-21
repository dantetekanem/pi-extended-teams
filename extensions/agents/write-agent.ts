import * as process from "node:process";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, requireFavoriteModelLevel } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { buildPiCommand, checkChildPiModelAvailability, getPiExtendedTeamsExtensionSource, getPiLaunchCommand } from "../internal/pi-command";
import { cleanupPrivateAgentSessionDirectory, preparePrivateAgentSessionDirectory } from "../internal/agent-session-files";
import { countWriteMembers } from "../team/roster";
import type { ActiveWriterTab } from "../team/writer-screens";
import {
  createSpawnResourcePlan,
  type SpawnResourcePlan,
} from "../resources/spawn-resource-plan";
import {
  generateExtensionInstanceId,
  readLifecycleTombstone,
  withLifecycleTombstoneLock,
} from "../../src/utils/lifecycle-tombstone";
import type { ActiveAgentSleepController } from "../runtime/active-agent-sleep";

export interface WriteAgentRuntimeOptions {
  terminal: any;
  onWriterActive?(tab: ActiveWriterTab): void;
  onWriterInactive?(teamName: string, member: Member): void;
  getProjectTrusted?(cwd: string): boolean;
  createResourcePlan?(input: { cwd: string; projectTrusted: boolean }): SpawnResourcePlan | Promise<SpawnResourcePlan>;
  sleepController?: ActiveAgentSleepController;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopAndVerifySpawnedPane(terminal: any, paneId: string): string | null {
  let killError: unknown;
  try {
    terminal.kill(paneId);
  } catch (error) {
    killError = error;
  }

  if (typeof terminal.isAlive !== "function") {
    return `Could not verify termination of spawned pane ${paneId}: terminal.isAlive is unavailable${killError ? ` after kill failed: ${errorText(killError)}` : ""}.`;
  }

  try {
    const alive = terminal.isAlive(paneId);
    if (alive === false) return null;
    if (alive === true) {
      return `Could not verify termination of spawned pane ${paneId}: the terminal still reports it alive${killError ? ` after kill failed: ${errorText(killError)}` : ""}.`;
    }
    return `Could not verify termination of spawned pane ${paneId}: terminal.isAlive returned a non-boolean result.`;
  } catch (error) {
    return `Could not verify termination of spawned pane ${paneId}: terminal.isAlive failed: ${errorText(error)}${killError ? `; kill also failed: ${errorText(killError)}` : ""}.`;
  }
}

function assertWriterUsesConfiguredLevel(member: Member): void {
  const settings = loadSettings({ projectDir: member.cwd });
  const level = requireFavoriteModelLevel(settings, member.modelSlot);
  if (level.role !== "write" || member.role !== "write") {
    throw new Error(`Write agent ${member.name} must use a write-* intent tier configured via /agents-favorite-models. Spawn agents by intent tier only.`);
  }
  if (member.model !== level.model || member.thinking !== level.thinking) {
    throw new Error(`Write agent ${member.name} must use configured intent tier ${level.slot}; direct model/thinking overrides are not allowed.`);
  }
}

export function createWriteAgentRuntime(options: WriteAgentRuntimeOptions) {
  let writeQueueDraining = false;
  const extensionInstanceId = generateExtensionInstanceId();
  const writerSleepAssertions = new Map<string, () => void>();

  function writerSleepAssertionKey(teamName: string, member: Member): string | null {
    return member.lifecycleRunId ? `${teamName}:${member.name}:${member.lifecycleRunId}` : null;
  }

  function retainWriteAgentSleepAssertion(teamName: string, member: Member): void {
    const key = writerSleepAssertionKey(teamName, member);
    if (!key || writerSleepAssertions.has(key) || !options.sleepController) return;
    writerSleepAssertions.set(key, options.sleepController.retain());
  }

  function releaseWriteAgentSleepAssertion(teamName: string, member: Member): void {
    const key = writerSleepAssertionKey(teamName, member);
    if (!key) return;
    const release = writerSleepAssertions.get(key);
    if (!release) return;
    writerSleepAssertions.delete(key);
    release();
  }

  async function startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string> {
    assertWriterUsesConfiguredLevel(member);
    if (!options.terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

    const settings = loadSettings({ projectDir: member.cwd });
    const debugEnabled = isTeamsDebugEnabled(settings);
    const debugLogPath = debugEnabled ? teamDebugLogPath(teamName) : undefined;
    const piBinary = getPiLaunchCommand();
    const resourcePlan = await (options.createResourcePlan ?? createSpawnResourcePlan)({
      cwd: member.cwd,
      projectTrusted: options.getProjectTrusted?.(member.cwd) === true,
    });
    const extensionSource = resourcePlan.selfExtensionPath ?? getPiExtendedTeamsExtensionSource();
    const requestedModel = member.model;
    const modelPreflight = checkChildPiModelAvailability(piBinary, requestedModel, resourcePlan.extensionPaths, {
      projectTrusted: resourcePlan.trust.projectTrusted,
      selfExtensionSource: extensionSource,
    });
    let launchModel = requestedModel;
    let modelFallback: string | null = null;

    if (modelPreflight.status === "missing") {
      modelFallback = requestedModel ?? null;
      launchModel = undefined;
      member = { ...member, model: undefined };
    }

    await teams.addMember(teamName, member);
    const failedRunId = member.lifecycleRunId!;
    const bootstrapOperationId = `bootstrap:${failedRunId}:initial-prompt`;
    let spawnedTerminalId: string | undefined;

    try {
      const sessionDir = settings.agentSessions.showInResume
        ? undefined
        : preparePrivateAgentSessionDirectory(teamName, member.name, failedRunId);
      const piCmd = buildPiCommand(
        piBinary,
        launchModel,
        member.thinking,
        resourcePlan.extensionPaths,
        resourcePlan.trust.projectTrusted,
        extensionSource,
        sessionDir,
      );
      await runtime.writeRuntimeStatus(teamName, member.name, failedRunId, {
        startedAt: member.joinedAt,
        lastHeartbeatAt: member.joinedAt,
        ready: false,
        currentAction: "starting",
      });
      await messaging.sendPlainMessageOnceIfRunning(
        teamName,
        "team-lead",
        member.name,
        prompt,
        "Initial prompt",
        {
          operationId: bootstrapOperationId,
          expectedRecipientRunId: failedRunId,
        }
      );
      if (modelFallback) {
        await messaging.sendPlainMessage(
          teamName,
          "system",
          "team-lead",
          `Write teammate ${member.name} could not use model ${modelFallback} in the child Pi process, so it was launched without --model and will use Pi's default model.`,
          `Write teammate ${member.name} launched with default model`,
          "yellow"
        );
      }

      const env: Record<string, string> = {
        ...process.env,
        PI_TEAM_NAME: teamName,
        PI_AGENT_NAME: member.name,
        PI_LIFECYCLE_RUN_ID: failedRunId,
      };

      await writeTeamsDebugEvent(teamName, "write-agent.spawn.prepare", {
        agentName: member.name,
        cwd: member.cwd,
        model: requestedModel ?? null,
        launchModel: launchModel ?? null,
        thinking: member.thinking ?? null,
        piBinary,
        extensionSource,
        resourcePlan: {
          extensionPaths: resourcePlan.extensionPaths,
          diagnostics: resourcePlan.diagnostics,
          trust: resourcePlan.trust,
          skills: resourcePlan.skills,
        },
        modelPreflight: {
          status: modelPreflight.status,
          command: modelPreflight.command,
          exitStatus: modelPreflight.exitStatus,
          stderr: modelPreflight.stderr.slice(0, 2000),
          stdout: modelPreflight.stdout.slice(0, 2000),
        },
        command: piCmd,
        debugLogPath: debugLogPath ?? null,
      }, settings);

      const teamConfig = await teams.readConfig(teamName);
      const leadMember = teamConfig.members.find(m => m.name === "team-lead");
      const anchorPaneId = leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined;
      retainWriteAgentSleepAssertion(teamName, member);
      const terminalId: string = spawnedTerminalId = options.terminal.spawn({
        name: member.name,
        cwd: member.cwd,
        command: piCmd,
        env,
        anchorPaneId,
      });
      const windowId = options.terminal.getWindowIdForPane?.(terminalId) ?? undefined;
      await teams.updateMember(teamName, member.name, { tmuxPaneId: terminalId, windowId });
      options.onWriterActive?.({ teamName, name: member.name, paneId: terminalId, windowId, joinedAt: member.joinedAt });
      await writeTeamsDebugEvent(teamName, "write-agent.spawn.success", {
        agentName: member.name,
        terminalId,
        windowId: windowId ?? null,
        anchorPaneId: anchorPaneId ?? null,
        debugLogPath: debugLogPath ?? null,
      }, settings);
      return terminalId;
    } catch (e) {
      // A pane returned by spawn belongs to this run even if roster ownership has
      // already moved on. Stop and synchronously verify that exact process before
      // any awaited diagnostics or lifecycle/roster ownership checks can yield.
      const terminationError = spawnedTerminalId === undefined
        ? null
        : stopAndVerifySpawnedPane(options.terminal, spawnedTerminalId);

      try {
        // Debug I/O may yield or fail; lifecycle ownership is therefore revalidated
        // only after the best-effort log, under the recipient fence, before rollback.
        try {
          await writeTeamsDebugEvent(teamName, "write-agent.spawn.failure", {
            agentName: member.name,
            error: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack ?? null : null,
            debugLogPath: debugLogPath ?? null,
          }, settings);
        } catch {
          // Spawn rollback must not be skipped because its diagnostic write failed.
        }
        await withLifecycleTombstoneLock(teamName, member.name, async lifecycleLock => {
          const fence = lifecycleLock.read();
          if (fence.status === "corrupt") return;
          if (fence.status === "occupied" && fence.tombstone.runId !== failedRunId) return;

          const currentConfig = await teams.readConfig(teamName).catch(() => null);
          const currentMember = currentConfig?.members.find(item => item.name === member.name);
          if (!currentMember || currentMember.lifecycleRunId !== failedRunId) return;

          if (terminationError) {
            lifecycleLock.occupy({
              team: teamName,
              agent: member.name,
              runId: failedRunId,
              role: "write",
              reason: "spawn_rollback",
              phase: "cleanup_failed",
              extensionInstanceId,
            });
            lifecycleLock.updateMatching(failedRunId, {
              phase: "cleanup_failed",
              error: terminationError,
            });
            return;
          }

          try {
            options.onWriterInactive?.(teamName, currentMember);
          } catch {
            // In-memory observers must not prevent cleanup after exact pane termination.
          }
          await messaging.removeInboxMessagesByOperationUnderLifecycleLock(teamName, member.name, bootstrapOperationId);
          await runtime.deleteRuntimeStatusUnderLifecycleLock(teamName, member.name, failedRunId);
          await teams.removeMemberMatchingRun(teamName, member.name, failedRunId);
          if (!settings.agentSessions.showInResume) {
            try {
              cleanupPrivateAgentSessionDirectory(teamName, member.name, failedRunId);
            } catch {
              // A later private-session janitor can retry cleanup without hiding the spawn error.
            }
          }
        });
      } finally {
        releaseWriteAgentSleepAssertion(teamName, member);
      }
      const debugHint = debugLogPath ? ` (debug log: ${debugLogPath})` : "";
      throw new Error(`Failed to spawn background tmux screen: ${e}${debugHint}`);
    }
  }

  async function drainWriteQueue(teamName: string): Promise<void> {
    if (writeQueueDraining) return;
    writeQueueDraining = true;
    try {
      while (true) {
        const drainedAny = await writeQueue.withWriteQueueCapacityLock(teamName, async () => {
          const [nextQueued] = await writeQueue.listWriteQueue(teamName);
          if (!nextQueued) return false;

          const fence = await readLifecycleTombstone(teamName, nextQueued.name);
          if (fence.status !== "absent") {
            await messaging.sendPlainMessage(
              teamName,
              "system",
              "team-lead",
              `Retained queued writer ${nextQueued.name}: its recipient name is lifecycle-quarantined${fence.status === "occupied" ? ` for run ${fence.tombstone.runId}` : " by a corrupt tombstone"}.`,
              `Queued writer ${nextQueued.name} blocked by quarantine`,
              "yellow"
            );
            return false;
          }

          const settings = loadSettings({ projectDir: nextQueued.cwd });
          const activeWriteCount = await countWriteMembers(teamName, options.terminal);
          const availableSlots = settings.writeAgents.maxConcurrent - activeWriteCount;
          if (availableSlots <= 0) return false;

          // Keep the fence-checked head durable until admission succeeds. If a
          // tombstone appears between this check and addMember, the item remains.
          const queuedBatch = [nextQueued];
          let retainedByFence = false;

          for (const queued of queuedBatch) {
            const config = await teams.readConfig(teamName);
            if (config.members.some(member => member.name === queued.name)) {
              await writeQueue.cancelQueuedWriteSpawn(teamName, queued.id);
              await messaging.sendPlainMessage(
                teamName,
                "system",
                "team-lead",
                `Skipped queued writer ${queued.name} because a teammate with that name already exists.`,
                `Skipped queued writer ${queued.name}`,
                "yellow"
              );
              continue;
            }

            const member = writeQueue.queuedWriteSpawnToMember(teamName, queued);
            try {
              const terminalId = await startWriteAgent(teamName, member, queued.prompt);
              await writeQueue.cancelQueuedWriteSpawn(teamName, queued.id);
              await messaging.sendPlainMessage(
                teamName,
                "system",
                "team-lead",
                `Queued writer ${queued.name} started in background tmux screen ${terminalId}.`,
                `Queued writer ${queued.name} started`,
                "green"
              );
            } catch (e) {
              const latestFence = await readLifecycleTombstone(teamName, queued.name);
              if (latestFence.status !== "absent") {
                retainedByFence = true;
                await messaging.sendPlainMessage(
                  teamName,
                  "system",
                  "team-lead",
                  `Retained queued writer ${queued.name}: lifecycle quarantine appeared before admission.`,
                  `Queued writer ${queued.name} retained by quarantine`,
                  "yellow"
                );
                continue;
              }
              await writeQueue.cancelQueuedWriteSpawn(teamName, queued.id);
              await messaging.sendPlainMessage(
                teamName,
                "system",
                "team-lead",
                `Queued writer ${queued.name} failed to start: ${e instanceof Error ? e.message : String(e)}`,
                `Queued writer ${queued.name} failed`,
                "red"
              );
            }
          }

          return !retainedByFence;
        });

        if (!drainedAny) return;
      }
    } finally {
      writeQueueDraining = false;
    }
  }

  return { startWriteAgent, drainWriteQueue, releaseWriteAgentSleepAssertion };
}
