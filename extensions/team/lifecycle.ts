import * as fs from "node:fs";
import * as path from "node:path";
import * as paths from "../../src/utils/paths";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as teams from "../../src/utils/teams";
import { loadSettings } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import { shutdownReadAgentSession } from "../agents/read-agent";
import { releaseAllClaimsForAgent } from "./roster";

export interface LifecycleRuntimeOptions {
  isTeammate: boolean;
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  renderReadAgentStatus(): void;
  drainWriteQueue(teamName: string): Promise<void>;
  getSessionCwd(): string | undefined;
  getTeamName(): string | null | undefined;
}

export function createLifecycleRuntime(options: LifecycleRuntimeOptions) {
  let leadWatchdogStarted = false;

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    if (member.role === "read") {
      const key = options.readAgentKey(teamName, member.name);
      const state = options.runningReadAgents.get(key);
      if (state) state.stopRequested = true;
      if (state?.session) {
        await shutdownReadAgentSession(state.session);
        state.session.dispose();
      }
      if (state && options.isCurrentReadAgentRun(key, state)) {
        options.runningReadAgents.delete(key);
      }
      options.renderReadAgentStatus();
      await runtime.deleteRuntimeStatus(teamName, member.name);
      return;
    }

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf-8").trim();
        process.kill(parseInt(pid), "SIGKILL");
        fs.unlinkSync(pidFile);
      } catch {
        // ignore
      }
    }

    if (member.tmuxPaneId && options.terminal) {
      options.terminal.kill(member.tmuxPaneId);
    }

    await runtime.deleteRuntimeStatus(teamName, member.name);
  }

  async function shutdownTeammate(
    teamName: string,
    member: Member,
    shutdownOptions: { drainQueue?: boolean } = {}
  ): Promise<void> {
    if (member.name === "team-lead") return;

    const drainQueue = shutdownOptions.drainQueue ?? true;
    await releaseAllClaimsForAgent(teamName, member.name);
    await killTeammate(teamName, member);
    await teams.removeMember(teamName, member.name);
    if (drainQueue && (member.role ?? "write") === "write") {
      await options.drainWriteQueue(teamName);
    }
  }

  function teammateRuntimeIsStale(status: runtime.AgentRuntimeStatus | null, maxAgeMs: number): boolean {
    if (!status) return false;
    const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
    return lastActivity > 0 && (Date.now() - lastActivity) > maxAgeMs;
  }

  async function reapTeammate(teamName: string, member: Member, reason: string): Promise<void> {
    await shutdownTeammate(teamName, member);
    await messaging.sendPlainMessage(
      teamName,
      "watchdog",
      "team-lead",
      `Reaped ${member.name}: ${reason}`,
      `Watchdog reaped ${member.name}`,
      "yellow"
    );
  }

  async function runWatchdogOnce(targetTeamName: string): Promise<void> {
    const settings = loadSettings({ projectDir: options.getSessionCwd() || process.cwd() });
    const staleMs = runtime.HEARTBEAT_STALE_MS + settings.watchdog.bufferSeconds * 1000;
    const config = await teams.readConfig(targetTeamName);

    for (const member of config.members) {
      if (member.name === "team-lead") continue;
      const role = member.role ?? "write";
      const runtimeStatus = await runtime.readRuntimeStatus(targetTeamName, member.name);
      const runtimeStale = teammateRuntimeIsStale(runtimeStatus, staleMs);

      if (role === "read") {
        if (runtimeStale && !options.runningReadAgents.has(options.readAgentKey(targetTeamName, member.name))) {
          await reapTeammate(targetTeamName, member, "read-agent heartbeat is stale and no in-process session is running");
        }
        continue;
      }

      const paneAlive = !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId));
      if (!paneAlive) {
        await reapTeammate(targetTeamName, member, "tmux pane is gone");
        continue;
      }

      if (runtimeStale) {
        await reapTeammate(targetTeamName, member, `heartbeat is stale for more than ${Math.round(staleMs / 1000)}s`);
      }
    }

    await runtime.cleanupStaleRuntimeFiles(targetTeamName);
  }

  function startLeadWatchdog() {
    if (leadWatchdogStarted || options.isTeammate || !options.getSessionCwd()) return;
    leadWatchdogStarted = true;
    setInterval(async () => {
      const teamName = options.getTeamName();
      if (!teamName) return;
      try {
        await runWatchdogOnce(teamName);
      } catch {
        // Keep watchdog quiet; health is visible via /team and inbox messages on actual reaps.
      }
    }, 30000);
  }

  return { killTeammate, shutdownTeammate, runWatchdogOnce, startLeadWatchdog };
}
