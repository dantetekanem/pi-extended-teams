import * as fs from "node:fs";
import * as path from "node:path";
import * as paths from "../../src/utils/paths";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as teams from "../../src/utils/teams";
import { loadSettings } from "../../src/utils/settings";
import { withLock } from "../../src/utils/lock";
import type { Member, TeamConfig } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import { shutdownReadAgentSession } from "../agents/read-agent";
import { releaseAllClaimsForAgent } from "./roster";
import { cleanupPidFileProcess } from "../internal/session-files";

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
  onWriterInactive?(teamName: string, member: Member): void;
}

interface ShutdownTeammateOptions {
  drainQueue?: boolean;
  removeMember?: boolean;
}

interface ReapedTeammate {
  member: Member;
  reason: string;
}

export function createLifecycleRuntime(options: LifecycleRuntimeOptions) {
  let leadWatchdogStarted = false;

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

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

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    cleanupPidFileProcess(pidFile, { skipPid: process.pid });

    if (member.tmuxPaneId && options.terminal) {
      options.terminal.kill(member.tmuxPaneId);
    }

    if ((member.role ?? "write") === "write") {
      options.onWriterInactive?.(teamName, member);
    }

    await runtime.deleteRuntimeStatus(teamName, member.name);
  }

  async function removeMembersFromTeamConfig(teamName: string, memberNames: Set<string>): Promise<void> {
    if (memberNames.size === 0) return;

    const configPath = paths.configPath(teamName);
    if (!fs.existsSync(configPath)) return;

    await withLock(configPath, async () => {
      if (!fs.existsSync(configPath)) return;
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as TeamConfig;
      const nextMembers = config.members.filter((member) => !memberNames.has(member.name));
      if (nextMembers.length === config.members.length) return;

      config.members = nextMembers;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    });
  }

  async function shutdownTeammate(
    teamName: string,
    member: Member,
    shutdownOptions: ShutdownTeammateOptions = {}
  ): Promise<void> {
    if (member.name === "team-lead") return;

    const drainQueue = shutdownOptions.drainQueue ?? true;
    const removeMember = shutdownOptions.removeMember ?? true;
    await releaseAllClaimsForAgent(teamName, member.name);
    await killTeammate(teamName, member);
    if (removeMember) await teams.removeMember(teamName, member.name);
    if (drainQueue && (member.role ?? "write") === "write") {
      await options.drainWriteQueue(teamName);
    }
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

    await removeMembersFromTeamConfig(teamName, new Set(reaped.map(({ member }) => member.name)));

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

  async function runWatchdogOnce(targetTeamName: string): Promise<void> {
    const settings = loadSettings({ projectDir: options.getSessionCwd() || process.cwd() });
    const staleMs = runtime.HEARTBEAT_STALE_MS + settings.watchdog.bufferSeconds * 1000;
    const now = Date.now();
    const config = await teams.readConfig(targetTeamName);
    const members = config.members.filter((member) => member.name !== "team-lead");
    const runtimeStatusByMember = await readRuntimeStatusByMember(targetTeamName, members);
    const reaped: ReapedTeammate[] = [];

    try {
      for (const member of members) {
        const role = member.role ?? "write";
        const runtimeStatus = runtimeStatusByMember.get(member.name) ?? null;
        const runtimeStale = teammateRuntimeIsStale(runtimeStatus, staleMs, now);

        const key = options.readAgentKey(targetTeamName, member.name);
        const inProcessAlive = options.runningReadAgents.has(key);

        if (runtimeStale && !inProcessAlive) {
          await shutdownTeammate(targetTeamName, member, { drainQueue: false, removeMember: false });
          reaped.push({ member, reason: `${role}-agent heartbeat is stale and no in-process session is running` });
          continue;
        }

        const legacyPaneAlive = !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId));
        if (!inProcessAlive && member.tmuxPaneId && !legacyPaneAlive) {
          await shutdownTeammate(targetTeamName, member, { drainQueue: false, removeMember: false });
          reaped.push({ member, reason: "legacy tmux screen is gone" });
        }
      }
    } finally {
      await flushReapedTeammates(targetTeamName, reaped);
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
