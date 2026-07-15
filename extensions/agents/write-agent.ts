import * as process from "node:process";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, requireFavoriteModelLevel } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { buildPiCommand, checkChildPiModelAvailability, getPiExtendedTeamsExtensionSource, getPiLaunchCommand } from "../internal/pi-command";
import { countWriteMembers } from "../team/roster";
import type { ActiveWriterTab } from "../team/writer-screens";
import {
  createSpawnResourcePlan,
  type SpawnResourcePlan,
} from "../resources/spawn-resource-plan";
import { readLifecycleTombstone, withLifecycleTombstoneLock } from "../../src/utils/lifecycle-tombstone";

export interface WriteAgentRuntimeOptions {
  terminal: any;
  onWriterActive?(tab: ActiveWriterTab): void;
  onWriterInactive?(teamName: string, member: Member): void;
  getProjectTrusted?(cwd: string): boolean;
  createResourcePlan?(input: { cwd: string; projectTrusted: boolean }): SpawnResourcePlan | Promise<SpawnResourcePlan>;
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

    const piCmd = buildPiCommand(
      piBinary,
      launchModel,
      member.thinking,
      resourcePlan.extensionPaths,
      resourcePlan.trust.projectTrusted,
      extensionSource,
    );

    await teams.addMember(teamName, member);
    const failedRunId = member.lifecycleRunId!;
    const bootstrapOperationId = `bootstrap:${failedRunId}:initial-prompt`;

    try {
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
      const terminalId = options.terminal.spawn({
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
      // Debug I/O may yield; lifecycle ownership is therefore revalidated only
      // after logging, under the recipient fence, before any rollback mutation.
      await writeTeamsDebugEvent(teamName, "write-agent.spawn.failure", {
        agentName: member.name,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack ?? null : null,
        debugLogPath: debugLogPath ?? null,
      }, settings);
      await withLifecycleTombstoneLock(teamName, member.name, async lifecycleLock => {
        const fence = lifecycleLock.read();
        if (fence.status === "corrupt") return;
        if (fence.status === "occupied" && fence.tombstone.runId !== failedRunId) return;

        const currentConfig = await teams.readConfig(teamName).catch(() => null);
        const currentMember = currentConfig?.members.find(item => item.name === member.name);
        if (!currentMember || currentMember.lifecycleRunId !== failedRunId) return;

        options.onWriterInactive?.(teamName, currentMember);
        await messaging.removeInboxMessagesByOperationUnderLifecycleLock(teamName, member.name, bootstrapOperationId);
        await runtime.deleteRuntimeStatusUnderLifecycleLock(teamName, member.name, failedRunId);
        await teams.removeMemberMatchingRun(teamName, member.name, failedRunId);
      });
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

  return { startWriteAgent, drainWriteQueue };
}
