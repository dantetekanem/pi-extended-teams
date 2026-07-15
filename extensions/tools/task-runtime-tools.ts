import { Type } from "@sinclair/typebox";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import { formatTeammateStatusForModel, renderTeammateStatus } from "../ui/renderers";
import type { RunningReadAgent } from "../runtime/types";
import type { Member } from "../../src/utils/models";
import type { ReadAgentTeardownResult } from "../agents/read-agent-session-lifecycle";
import type { ShutdownTeammateOptions } from "../team/lifecycle";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone";

export interface TaskRuntimeToolsOptions {
  isTeammate: boolean;
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  shutdownTeammate(teamName: string, member: Member, options?: ShutdownTeammateOptions): Promise<ReadAgentTeardownResult>;
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
        let member = config.members.find(m => m.name === params.agent_name);
        const runningState = options.runningReadAgents.get(options.readAgentKey(teamName, params.agent_name));
        if (!member && runningState) {
          member = {
            agentId: `${params.agent_name}@${teamName}`,
            name: params.agent_name,
            agentType: "teammate",
            lifecycleRunId: runningState.runId,
            role: runningState.role === "write" ? "write" : "read",
            model: runningState.model,
            thinking: runningState.thinking as Member["thinking"],
            modelSlot: runningState.modelSlot as Member["modelSlot"],
            joinedAt: runningState.startedAt,
            tmuxPaneId: "",
            cwd: "",
            subscriptions: [],
          };
        }
        if (!member || member.name === "team-lead") {
          const fence = await readLifecycleTombstone(teamName, params.agent_name);
          if (fence.status !== "absent") {
            return {
              content: [{ type: "text", text: `Agent ${params.agent_name} is inactive but quarantined; lifecycle cleanup is still fenced.` }],
              details: {
                session: teamName,
                agentName: params.agent_name,
                stopped: false,
                quarantined: true,
                blocked: true,
                reason: params.reason,
                tombstone: fence.status === "occupied" ? fence.tombstone : undefined,
                error: fence.status === "corrupt" ? fence.error : undefined,
              },
            };
          }
          return {
            content: [{ type: "text", text: `Agent ${params.agent_name} is not active in this session.` }],
            details: { session: teamName, agentName: params.agent_name, stopped: false, reason: "not-active" },
          };
        }

        const teardown = await options.shutdownTeammate(teamName, member);
        const stopped = teardown.status === "settled" && teardown.finalized && teardown.removedMember;
        if (!stopped) {
          const blocked = teardown.status === "persistence_failed" ? "persistence-failed"
            : teardown.status === "timed_out" ? "quarantined"
              : "cleanup-blocked";
          return {
            content: [{ type: "text", text: `Agent ${params.agent_name} is inactive but ${blocked}; lifecycle cleanup did not complete${teardown.error ? `: ${teardown.error}` : "."}` }],
            details: {
              session: teamName,
              agentName: params.agent_name,
              stopped: false,
              quarantined: teardown.status === "timed_out",
              blocked: true,
              reason: params.reason,
              teardown,
            },
          };
        }
        return {
          content: [{ type: "text", text: `Stopped agent ${params.agent_name}${params.reason ? `: ${params.reason}` : "."}` }],
          details: { session: teamName, agentName: params.agent_name, stopped: true, reason: params.reason, teardown },
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
      if (!member) {
        const fence = await readLifecycleTombstone(teamName, params.agent_name);
        if (fence.status !== "absent") {
          const details = {
            agentName: params.agent_name,
            alive: false,
            unreadCount: 0,
            health: "quarantined",
            agentLoopReady: false,
            hasRecentHeartbeat: false,
            startupStalled: false,
            runtime: await runtime.readRuntimeStatus(teamName, params.agent_name).catch(() => null),
            teardownState: "quarantined",
            removedMember: false,
            releasedClaims: [],
            tombstone: fence.status === "occupied" ? fence.tombstone : undefined,
            error: fence.status === "corrupt" ? fence.error : undefined,
          };
          return { content: [{ type: "text", text: formatTeammateStatusForModel(params.agent_name, details) }], details };
        }
        throw new Error(`Agent ${params.agent_name} not found`);
      }

      const unreadCount = (await messaging.readInbox(teamName, params.agent_name, true, false)).length;
      const runtimeStatus = await runtime.readRuntimeStatus(teamName, params.agent_name).catch(() => null);
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
      const runningState = options.runningReadAgents.get(options.readAgentKey(teamName, member.name));
      const lifecycleHealth = runningState?.teardownState === "persistence_failed" ? "persistence-failed"
        : runningState?.teardownState === "quarantined" ? "quarantined"
          : runningState?.teardownState === "stopping" ? "stopping"
            : undefined;
      const memberActive = member.isActive !== false;
      const legacyPaneAlive = memberActive && !!(member.tmuxPaneId && options.terminal?.isAlive?.(member.tmuxPaneId));
      const inProcessAlive = !!runningState && !lifecycleHealth && runningState.teardownState !== "finalized";
      const alive = inProcessAlive || (memberActive && (hasRecentHeartbeat || legacyPaneAlive));
      const startupStalled = alive && unreadCount > 0 && (now - member.joinedAt) > runtime.STARTUP_STALL_MS && !(runtimeStatus?.ready);
      let health = lifecycleHealth
        ?? (!alive ? "dead" : startupStalled ? "stalled" : runtimeStatus?.ready && hasRecentHeartbeat ? "healthy" : runtimeStatus?.ready || legacyPaneAlive ? "idle" : "starting");
      let teardown: ReadAgentTeardownResult | undefined = runningState?.teardownResult;
      let lifecycleError: string | undefined;

      if (!alive && !lifecycleHealth) {
        try {
          teardown = await options.shutdownTeammate(teamName, member);
          if (teardown.status === "timed_out") health = "quarantined";
          else if (teardown.status === "persistence_failed") health = "persistence-failed";
          else if (teardown.status === "cleanup_failed" || !teardown.finalized) health = "cleanup-blocked";
        } catch (error) {
          lifecycleError = error instanceof Error ? error.message : String(error);
          health = "cleanup-blocked";
        }
      }

      const details = {
        agentName: params.agent_name,
        alive: lifecycleHealth ? false : alive,
        unreadCount,
        health,
        agentLoopReady: !lifecycleHealth && alive && !!runtimeStatus?.ready,
        hasRecentHeartbeat,
        startupStalled,
        runtime: runtimeStatus,
        teardownState: runningState?.teardownState,
        teardown,
        releasedClaims: teardown?.releasedClaims ?? [],
        removedMember: teardown?.removedMember ?? false,
        error: teardown?.error ?? lifecycleError,
      };
      return { content: [{ type: "text", text: formatTeammateStatusForModel(params.agent_name, details) }], details };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderTeammateStatus(result, expanded, theme);
    },
  });
}
