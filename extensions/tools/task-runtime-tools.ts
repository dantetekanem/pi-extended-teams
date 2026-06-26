import { Type } from "@sinclair/typebox";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import { formatTeammateStatusForModel, renderTeammateStatus } from "../ui/renderers";
import type { RunningReadAgent } from "../runtime/types";
import type { Member } from "../../src/utils/models";

export interface TaskRuntimeToolsOptions {
  isTeammate: boolean;
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  shutdownTeammate(teamName: string, member: Member, options?: { drainQueue?: boolean }): Promise<void>;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  getTeamName(): string | null | undefined;
}

export function registerTaskRuntimeTools(pi: any, options: TaskRuntimeToolsOptions): void {
  if (!options.isTeammate) {
    pi.registerTool({
      name: "stop_teammate",
      label: "Stop Agent",
      description: "Stop one active agent in the current Pi session, release its file claims, and remove it from the active roster. Use only when the user explicitly asks to cancel/stop an agent or the agent is no longer needed.",
      parameters: Type.Object({
        agent_name: Type.String(),
        reason: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: any) {
        const teamName = options.getTeamName();
        if (!teamName) throw new Error("No active agent session. Spawn an agent first.");

        const config = await teams.readConfig(teamName);
        const member = config.members.find(m => m.name === params.agent_name);
        if (!member || member.name === "team-lead") {
          return {
            content: [{ type: "text", text: `Agent ${params.agent_name} is not active in this session.` }],
            details: { session: teamName, agentName: params.agent_name, stopped: false, reason: "not-active" },
          };
        }

        await options.shutdownTeammate(teamName, member);
        return {
          content: [{ type: "text", text: `Stopped agent ${params.agent_name}${params.reason ? `: ${params.reason}` : "."}` }],
          details: { session: teamName, agentName: params.agent_name, stopped: true, reason: params.reason },
        };
      },
    });
  }

  pi.registerTool({
    name: "check_teammate",
    label: "Check Agent",
    description: "Check one agent's status in the current Pi session only for targeted diagnostics after it has been quiet for several minutes or appears unhealthy. Do not use immediately after sending a message, while waiting for normal work, or after a report has already arrived.",
    parameters: Type.Object({ agent_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const teamName = options.getTeamName();
      if (!teamName) throw new Error("No active agent session. Spawn an agent first.");

      const config = await teams.readConfig(teamName);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Agent ${params.agent_name} not found`);

      const unreadCount = (await messaging.readInbox(teamName, params.agent_name, true, false)).length;
      const runtimeStatus = await runtime.readRuntimeStatus(teamName, params.agent_name).catch(() => null);
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
      const runningState = options.runningReadAgents.get(options.readAgentKey(teamName, member.name));
      const legacyPaneAlive = !!(member.tmuxPaneId && options.terminal?.isAlive?.(member.tmuxPaneId));
      const alive = !!runningState || (!!runtimeStatus && hasRecentHeartbeat && member.isActive !== false) || legacyPaneAlive;
      const startupStalled = alive && unreadCount > 0 && (now - member.joinedAt) > runtime.STARTUP_STALL_MS && !(runtimeStatus?.ready);
      const health = !alive ? "dead" : startupStalled ? "stalled" : runtimeStatus?.ready ? (hasRecentHeartbeat ? "healthy" : "idle") : "starting";
      const releasedClaims = !alive ? await options.releaseAllClaimsForAgent(teamName, params.agent_name) : [];
      const details = {
        agentName: params.agent_name,
        alive,
        unreadCount,
        health,
        agentLoopReady: !!runtimeStatus?.ready,
        hasRecentHeartbeat,
        startupStalled,
        runtime: runtimeStatus,
        releasedClaims,
        removedMember: false,
      };

      if (!alive) {
        await options.shutdownTeammate(teamName, member).catch(async () => {
          if (runtimeStatus) await runtime.deleteRuntimeStatus(teamName, params.agent_name).catch(() => {});
          await teams.removeMember(teamName, params.agent_name).catch(() => {});
        });
        details.removedMember = true;
      }
      return { content: [{ type: "text", text: formatTeammateStatusForModel(params.agent_name, details) }], details };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderTeammateStatus(result, expanded, theme);
    },
  });
}
