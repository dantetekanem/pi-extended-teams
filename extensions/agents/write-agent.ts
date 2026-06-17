import * as process from "node:process";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, resolveAllowedExtensions } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { buildPiCommand, getPiExtendedTeamsExtensionSource, getPiLaunchCommand } from "../internal/pi-command";
import { countWriteMembers } from "../team/roster";

export interface WriteAgentRuntimeOptions {
  terminal: any;
}

export function createWriteAgentRuntime(options: WriteAgentRuntimeOptions) {
  let writeQueueDraining = false;

  async function startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string> {
    if (!options.terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

    await teams.addMember(teamName, member);
    await messaging.sendPlainMessage(teamName, "team-lead", member.name, prompt, "Initial prompt");

    const settings = loadSettings({ projectDir: member.cwd });
    const debugEnabled = isTeamsDebugEnabled(settings);
    const debugLogPath = debugEnabled ? teamDebugLogPath(teamName) : undefined;
    const piBinary = getPiLaunchCommand();
    const extensionSource = getPiExtendedTeamsExtensionSource();
    const allowedExtensions = resolveAllowedExtensions(settings);
    const piCmd = buildPiCommand(piBinary, member.model, member.thinking, allowedExtensions);

    const env: Record<string, string> = {
      ...process.env,
      PI_TEAM_NAME: teamName,
      PI_AGENT_NAME: member.name,
    };

    await writeTeamsDebugEvent(teamName, "write-agent.spawn.prepare", {
      agentName: member.name,
      cwd: member.cwd,
      model: member.model,
      thinking: member.thinking ?? null,
      piBinary,
      extensionSource,
      allowedExtensions,
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
      await teams.updateMember(teamName, member.name, { tmuxPaneId: terminalId });
      await writeTeamsDebugEvent(teamName, "write-agent.spawn.success", {
        agentName: member.name,
        terminalId,
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
      await teams.removeMember(teamName, member.name);
      const debugHint = debugLogPath ? ` (debug log: ${debugLogPath})` : "";
      throw new Error(`Failed to spawn tmux pane: ${e}${debugHint}`);
    }
  }

  async function drainWriteQueue(teamName: string): Promise<void> {
    if (writeQueueDraining) return;
    writeQueueDraining = true;
    try {
      const settings = loadSettings();
      while (await countWriteMembers(teamName, options.terminal) < settings.writeAgents.maxConcurrent) {
        const queued = await writeQueue.dequeueWriteSpawn(teamName);
        if (!queued) return;

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
            `Queued writer ${queued.name} started in pane ${terminalId}.`,
            `Queued writer ${queued.name} started`,
            "green"
          );
        } catch (e) {
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
    } finally {
      writeQueueDraining = false;
    }
  }

  return { startWriteAgent, drainWriteQueue };
}
