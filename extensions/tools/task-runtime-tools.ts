import * as fs from "node:fs";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { cleanupAgentSessionFolders } from "../internal/session-files";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
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
}

export function registerTaskRuntimeTools(pi: any, options: TaskRuntimeToolsOptions): void {
  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "Create a new team task.",
    parameters: Type.Object({ team_name: Type.String(), subject: Type.String(), description: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const task = await tasks.createTask(params.team_name, params.subject, params.description);
      return { content: [{ type: "text", text: `Task ${task.id} created.` }], details: { task } };
    },
  });

  pi.registerTool({
    name: "task_submit_plan",
    label: "Submit Plan",
    description: "Submit a plan for a task, updating its status to 'planning'.",
    parameters: Type.Object({ team_name: Type.String(), task_id: Type.String(), plan: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const updated = await tasks.submitPlan(params.team_name, params.task_id, params.plan);
      return { content: [{ type: "text", text: `Plan submitted for task ${params.task_id}.` }], details: { task: updated } };
    },
  });

  pi.registerTool({
    name: "task_evaluate_plan",
    label: "Evaluate Plan",
    description: "Evaluate a submitted plan for a task.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      action: StringEnum(["approve", "reject"]),
      feedback: Type.Optional(Type.String({ description: "Required for rejection" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const updated = await tasks.evaluatePlan(params.team_name, params.task_id, params.action as any, params.feedback);
      return { content: [{ type: "text", text: `Plan for task ${params.task_id} has been ${params.action}d.` }], details: { task: updated } };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "List all tasks for a team.",
    parameters: Type.Object({ team_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const taskList = await tasks.listTasks(params.team_name);
      return { content: [{ type: "text", text: JSON.stringify(taskList, null, 2) }], details: { tasks: taskList } };
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "Update a task's status or owner.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      status: Type.Optional(StringEnum(["pending", "planning", "in_progress", "completed", "deleted"])),
      owner: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const updated = await tasks.updateTask(params.team_name, params.task_id, { status: params.status as any, owner: params.owner });
      return { content: [{ type: "text", text: `Task ${params.task_id} updated.` }], details: { task: updated } };
    },
  });

  pi.registerTool({
    name: "team_shutdown",
    label: "Shutdown Team",
    description: "Shutdown the entire team and close all panes/windows.",
    parameters: Type.Object({ team_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const teamName = params.team_name;
      try {
        const config = await teams.readConfig(teamName);
        for (const member of config.members) await options.shutdownTeammate(teamName, member, { drainQueue: false });
        const dir = paths.teamDir(teamName);
        const tasksDir = paths.taskDir(teamName);
        if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true });
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
        const cleanedSessions = cleanupAgentSessionFolders(60 * 60 * 1000);
        return {
          content: [{ type: "text", text: `Team ${teamName} shut down.${cleanedSessions > 0 ? ` Cleaned up ${cleanedSessions} orphaned agent session folder(s).` : ""}` }],
          details: { cleanedSessions },
        };
      } catch (e) {
        throw new Error(`Failed to shutdown team: ${e}`);
      }
    },
  });

  pi.registerTool({
    name: "cleanup_agent_sessions",
    label: "Cleanup Agent Sessions",
    description: "Clean up orphaned agent session folders from ~/.pi/agent/teams/ that are older than a specified age.",
    parameters: Type.Object({ max_age_hours: Type.Optional(Type.Number()) }),
    async execute(_toolCallId: string, params: any) {
      const maxAgeHours = params.max_age_hours ?? 24;
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
      const cleaned = cleanupAgentSessionFolders(maxAgeMs);
      return { content: [{ type: "text", text: `Cleaned up ${cleaned} orphaned agent session folder(s) older than ${maxAgeHours} hour(s).` }], details: { cleaned, maxAgeHours } };
    },
  });

  pi.registerTool({
    name: "task_read",
    label: "Read Task",
    description: "Read details of a specific task.",
    parameters: Type.Object({ team_name: Type.String(), task_id: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const task = await tasks.readTask(params.team_name, params.task_id);
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }], details: { task } };
    },
  });

  pi.registerTool({
    name: "check_teammate",
    label: "Check Teammate",
    description: "Check a single teammate's status.",
    parameters: Type.Object({ team_name: Type.String(), agent_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

      const unreadCount = (await messaging.readInbox(params.team_name, params.agent_name, true, false)).length;
      const runtimeStatus = await runtime.readRuntimeStatus(params.team_name, params.agent_name);
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;

      let alive = false;
      if (member.role === "read") {
        alive = options.runningReadAgents.has(options.readAgentKey(params.team_name, member.name)) || (!!runtimeStatus && hasRecentHeartbeat && member.isActive !== false);
      } else if (member.tmuxPaneId && options.terminal) {
        alive = options.terminal.isAlive(member.tmuxPaneId);
      }
      const startupStalled = alive && unreadCount > 0 && (now - member.joinedAt) > runtime.STARTUP_STALL_MS && !(runtimeStatus?.ready);
      const health = !alive ? "dead" : startupStalled ? "stalled" : runtimeStatus?.ready ? (hasRecentHeartbeat ? "healthy" : "idle") : "starting";
      const releasedClaims = !alive ? await options.releaseAllClaimsForAgent(params.team_name, params.agent_name) : [];
      const details = { agentName: params.agent_name, alive, unreadCount, health, agentLoopReady: !!runtimeStatus?.ready, hasRecentHeartbeat, startupStalled, runtime: runtimeStatus, releasedClaims };

      if (!alive && runtimeStatus) await runtime.deleteRuntimeStatus(params.team_name, params.agent_name);
      return { content: [{ type: "text", text: formatTeammateStatusForModel(params.agent_name, details) }], details };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderTeammateStatus(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "process_shutdown_approved",
    label: "Process Shutdown Approved",
    description: "Process a teammate's shutdown.",
    parameters: Type.Object({ team_name: Type.String(), agent_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);
      await options.shutdownTeammate(params.team_name, member);
      return { content: [{ type: "text", text: `Teammate ${params.agent_name} has been shut down.` }], details: {} };
    },
  });
}
