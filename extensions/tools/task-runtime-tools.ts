import { Type } from "@sinclair/typebox";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import { formatTeammateStatusForModel, renderTeammateStatus } from "../ui/renderers";
import type { RunningReadAgent } from "../runtime/types";
import type { Member } from "../../src/utils/models";

export interface TaskRuntimeToolsOptions {
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  shutdownTeammate(teamName: string, member: Member, options?: { drainQueue?: boolean }): Promise<void>;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  getTeamName(): string | null | undefined;
}

export function registerTaskRuntimeTools(pi: any, options: TaskRuntimeToolsOptions): void {
  pi.registerTool({
    name: "check_teammate",
    label: "Check Agent",
    description: "Check one agent's status in the current Pi session. This is the only public health/debug tool; the session is implicit.",
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
