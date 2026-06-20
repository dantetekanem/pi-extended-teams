import * as process from "node:process";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, resolveAllowedExtensions } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { buildPiCommand, checkChildPiModelAvailability, getPiExtendedTeamsExtensionSource, getPiLaunchCommand } from "../internal/pi-command";
import { countWriteMembers } from "../team/roster";
import { isWorkflowSpawnedMember } from "../../src/utils/workflow-metadata";
import type { ActiveWriterTab } from "../team/writer-screens";

export interface WriteAgentRuntimeOptions {
  terminal: any;
  onWriterActive?(tab: ActiveWriterTab): void;
  onWriterInactive?(teamName: string, member: Member): void;
}

export function createWriteAgentRuntime(options: WriteAgentRuntimeOptions) {
  let writeQueueDraining = false;

  async function startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string> {
    if (!options.terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

    const settings = loadSettings({ projectDir: member.cwd });
    const debugEnabled = isTeamsDebugEnabled(settings);
    const debugLogPath = debugEnabled ? teamDebugLogPath(teamName) : undefined;
    const piBinary = getPiLaunchCommand();
    const extensionSource = getPiExtendedTeamsExtensionSource();
    const allowedExtensions = resolveAllowedExtensions(settings);
    const requestedModel = member.model;
    const modelPreflight = checkChildPiModelAvailability(piBinary, requestedModel, allowedExtensions);
    let launchModel = requestedModel;
    let modelFallback: string | null = null;
    const noSkills = isWorkflowSpawnedMember(member);

    if (modelPreflight.status === "missing") {
      modelFallback = requestedModel ?? null;
      launchModel = undefined;
      member = { ...member, model: undefined };
    }

    const piCmd = buildPiCommand(piBinary, launchModel, member.thinking, allowedExtensions, noSkills);

    await teams.addMember(teamName, member);
    await messaging.sendPlainMessage(teamName, "team-lead", member.name, prompt, "Initial prompt");
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
    };

    await writeTeamsDebugEvent(teamName, "write-agent.spawn.prepare", {
      agentName: member.name,
      cwd: member.cwd,
      model: requestedModel ?? null,
      launchModel: launchModel ?? null,
      thinking: member.thinking ?? null,
      piBinary,
      extensionSource,
      allowedExtensions,
      noSkills,
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

    try {
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
      await writeTeamsDebugEvent(teamName, "write-agent.spawn.failure", {
        agentName: member.name,
        error: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack ?? null : null,
        debugLogPath: debugLogPath ?? null,
      }, settings);
      options.onWriterInactive?.(teamName, member);
      await teams.removeMember(teamName, member.name);
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

          const settings = loadSettings({ projectDir: nextQueued.cwd });
          const activeWriteCount = await countWriteMembers(teamName, options.terminal);
          const availableSlots = settings.writeAgents.maxConcurrent - activeWriteCount;
          if (availableSlots <= 0) return false;

          const queuedBatch = await writeQueue.dequeueWriteSpawns(teamName, availableSlots);
          if (queuedBatch.length === 0) return false;

          for (const queued of queuedBatch) {
            const config = await teams.readConfig(teamName);
            if (config.members.some(member => member.name === queued.name)) {
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
              await messaging.sendPlainMessage(
                teamName,
                "system",
                "team-lead",
                `Queued writer ${queued.name} started in background tmux screen ${terminalId}.`,
                `Queued writer ${queued.name} started`,
                "green"
              );
            } catch (e) {
              await messaging.sendPlainMessage(
                teamName,
                "system",
                "team-lead",
                `Queued writer ${queued.name} failed to start after being dequeued: ${e instanceof Error ? e.message : String(e)}`,
                `Queued writer ${queued.name} failed`,
                "red"
              );
            }
          }

          return true;
        });

        if (!drainedAny) return;
      }
    } finally {
      writeQueueDraining = false;
    }
  }

  return { startWriteAgent, drainWriteQueue };
}
