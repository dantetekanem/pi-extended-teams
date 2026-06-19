import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as sharedMemory from "../../src/utils/shared-memory";
import * as reportEvents from "../../src/utils/report-events";
import { formatInboxMessagesForModel, renderInboxMessages } from "../ui/renderers";
import { StringEnum } from "../internal/schema";
import { requestLeadForTeammateSpawn } from "./delegation-guard";
import { unlinkPidFile } from "../internal/session-files";
import { summarizeSessionUsage } from "../internal/session-usage";
import { enqueueReadHelperRequest, listReadHelperQueue } from "../../src/utils/read-helper-queue";
import { memberWorkflowRunId, workflowAllowsReadHelper, workflowAllowsSkill } from "../../src/utils/workflow-metadata";

export interface CoordinationToolsOptions {
  agentName: string;
  isTeammate: boolean;
  terminal: any;
  getTeamName(): string | null | undefined;
  requireWriteAgentTeam(): Promise<string>;
  requireTeamContext(explicitTeamName?: string): string;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  drainWriteQueue(teamName: string): Promise<void>;
  resolveSkillFile(skillName: string, cwd: string): string;
  adoptTeamAsLead(teamName: string, ctx?: any): void;
  renderLeadInboxStatus(): Promise<void>;
  resetLeadWakeNotifiedCount(): void;
}

export function buildReadHelperPrompt(teamName: string, requester: string, prompt: string): string {
  return [
    `You are a read-only helper requested by write agent '${requester}' on team '${teamName}'.`,
    "Do not edit files, claim files, install packages, start services, commit, push, deploy, or make mutating changes.",
    "Investigate only what the requester asked for. Keep the final report concise and evidence-backed.",
    `When finished, you must call send_message to send your full report to '${requester}', then call send_message to send only a short done notification to team-lead. After both messages are sent, write a brief final answer confirming the report was sent and stop. There is no exception to this rule.`,
    "Mission:",
    prompt,
  ].join("\n\n");
}

function uniqueGeneratedHelperName(teamConfig: any, requester: string, queuedNames: string[] = []): string {
  const base = paths.sanitizeName(`${requester}-reader`);
  const existingNames = new Set([
    ...(teamConfig.members || []).map((member: any) => member.name),
    ...queuedNames,
  ]);
  if (!existingNames.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function registerCoordinationTools(pi: any, options: CoordinationToolsOptions): void {
  pi.registerTool({
    name: "claim_file",
    label: "Claim File",
    description: "Claim one or more file paths before a write agent edits them. The claim is exclusive per path within the current team.",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "Repository-relative file paths to claim atomically." }) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = await options.requireWriteAgentTeam();
      const result = await claims.claimFiles(targetTeamName, options.agentName, params.paths);
      const blockedTasks = result.conflicts.length > 0
        ? await tasks.markOwnerTasksBlockedByFileClaims(targetTeamName, options.agentName, result.conflicts)
        : [];
      const unblockedTasks = result.granted.length > 0
        ? await tasks.clearOwnerFileClaimBlocks(targetTeamName, options.agentName, result.granted)
        : [];
      const text = result.conflicts.length > 0
        ? [
            `File claim request blocked for ${options.agentName}.`,
            "Conflicts:",
            ...result.conflicts.map(conflict => `- ${conflict.path} held by ${conflict.heldBy}`),
            blockedTasks.length > 0
              ? `Marked owned task(s) blocked: ${blockedTasks.map(task => task.id).join(", ")}`
              : "No owned open task was available to mark blocked.",
          ].join("\n")
        : result.granted.length > 0
          ? [
              `Claimed ${result.granted.length} file(s) for ${options.agentName}:`,
              ...result.granted.map(path => `- ${path}`),
              unblockedTasks.length > 0
                ? `Cleared file-claim blocker(s) from task(s): ${unblockedTasks.map(task => task.id).join(", ")}`
                : "No file-claim task blockers needed clearing.",
            ].join("\n")
          : `No file paths claimed for ${options.agentName}.`;

      return {
        content: [{ type: "text", text }],
        details: {
          agent: options.agentName,
          teamName: targetTeamName,
          ...result,
          blockedTaskIds: blockedTasks.map(task => task.id),
          unblockedTaskIds: unblockedTasks.map(task => task.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "release_file",
    label: "Release File",
    description: "Release one or more file claims held by the current write agent.",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "Repository-relative file paths to release." }) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = await options.requireWriteAgentTeam();
      const released = await claims.releaseFiles(targetTeamName, options.agentName, params.paths);
      const text = released.length > 0
        ? `Released ${released.length} file claim(s) for ${options.agentName}:\n${released.map(path => `- ${path}`).join("\n")}`
        : `No matching file claims held by ${options.agentName} were released.`;
      return { content: [{ type: "text", text }], details: { agent: options.agentName, teamName: targetTeamName, released } };
    },
  });

  pi.registerTool({
    name: "list_file_claims",
    label: "List File Claims",
    description: "List the current file claims for a team. Defaults to the current team context when available.",
    parameters: Type.Object({ team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = options.requireTeamContext(params.team_name);
      const currentClaims = (await claims.listClaims(targetTeamName)).sort((a, b) => a.path.localeCompare(b.path));
      const text = currentClaims.length > 0
        ? [`Current file claims for ${targetTeamName}:`, ...currentClaims.map(claim => `- ${claim.path} held by ${claim.agent} since ${new Date(claim.since).toISOString()}`)].join("\n")
        : `No current file claims for ${targetTeamName}.`;
      return { content: [{ type: "text", text }], details: { teamName: targetTeamName, claims: currentClaims } };
    },
  });

  pi.registerTool({
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Send a final report to the team lead, release all file claims, and shut down this teammate.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
      content: Type.String({ description: "Final report to send to team-lead." }),
      summary: Type.Optional(Type.String({ description: "Short inbox summary for the final report." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const targetTeamName = options.requireTeamContext(params.team_name);
      if (!options.isTeammate) throw new Error("report_and_exit is only available to teammates.");

      const config = await teams.readConfig(targetTeamName);
      const member = config.members.find(m => m.name === options.agentName);
      const tmuxPaneId = member?.tmuxPaneId;
      const runtimeStatus = await runtime.readRuntimeStatus(targetTeamName, options.agentName).catch(() => null);
      const sessionUsage = summarizeSessionUsage(ctx);
      const tokensUsed = typeof sessionUsage.tokensUsed === "number" ? sessionUsage.tokensUsed : runtimeStatus?.tokensUsed;
      const costUsd = sessionUsage.costUsd;
      const elapsedMs = runtimeStatus?.startedAt ? Date.now() - runtimeStatus.startedAt : undefined;
      const reportMetadata = {
        startedAt: runtimeStatus?.startedAt,
        elapsedMs,
        tokensUsed,
        costUsd,
        model: member?.model,
        thinking: member?.thinking,
      };

      await messaging.sendPlainMessage(targetTeamName, options.agentName, "team-lead", params.content, params.summary || "Final report", undefined, { metadata: reportMetadata });
      await reportEvents.appendTeamReportEvent(targetTeamName, {
        agentName: options.agentName,
        role: member?.role || "write",
        status: "completed",
        report: params.content,
        summary: params.summary || "Final report",
        startedAt: runtimeStatus?.startedAt,
        elapsedMs,
        tokensUsed,
        costUsd,
        source: "write-agent",
        model: member?.model,
        thinking: member?.thinking,
        color: member?.color,
        operationId: member?.metadata?.operationId || member?.metadata?.orchestration?.operationId,
        workflowRunId: member?.metadata?.workflowRunId || member?.metadata?.orchestration?.workflowRunId,
      }).catch(() => {});
      const releasedClaims = await options.releaseAllClaimsForAgent(targetTeamName, options.agentName);
      unlinkPidFile(path.join(paths.teamDir(targetTeamName), `${options.agentName}.pid`));
      await runtime.deleteRuntimeStatus(targetTeamName, options.agentName);
      await teams.removeMember(targetTeamName, options.agentName);
      await options.drainWriteQueue(targetTeamName);

      setTimeout(() => {
        void (async () => {
          try {
            if (tmuxPaneId && options.terminal) options.terminal.kill(tmuxPaneId);
          } catch {
            // Ignore shutdown cleanup races; this tool is already exiting.
          } finally {
            try { ctx.shutdown(); } catch { process.exit(0); }
          }
        })();
      }, 250);

      return {
        content: [{ type: "text", text: `Final report sent to team-lead. Released ${releasedClaims.length} file claim(s). Exiting.` }],
        details: { teamName: targetTeamName, releasedClaims },
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a teammate.",
    parameters: Type.Object({ team_name: Type.String(), recipient: Type.String(), content: Type.String(), summary: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      await messaging.sendPlainMessage(params.team_name, options.agentName, params.recipient, params.content, params.summary);
      return { content: [{ type: "text", text: `Message sent to ${params.recipient}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "broadcast_message",
    label: "Broadcast Message",
    description: "Broadcast a message to all team members except the sender.",
    parameters: Type.Object({ team_name: Type.String(), content: Type.String(), summary: Type.String(), color: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, params: any) {
      await messaging.broadcastMessage(params.team_name, options.agentName, params.content, params.summary, params.color);
      return { content: [{ type: "text", text: `Message broadcasted to all team members.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "send_message_once",
    label: "Send Message Once",
    description: "Idempotently send a message to a teammate using operation_id/workflow_run_id metadata.",
    parameters: Type.Object({
      team_name: Type.String(),
      recipient: Type.String(),
      content: Type.String(),
      summary: Type.String(),
      operation_id: Type.String(),
      workflow_run_id: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const result = await messaging.sendPlainMessageOnce(params.team_name, options.agentName, params.recipient, params.content, params.summary, {
        operationId: params.operation_id,
        workflowRunId: params.workflow_run_id,
        color: params.color,
        metadata: { operationId: params.operation_id, ...(params.workflow_run_id ? { workflowRunId: params.workflow_run_id } : {}) },
      });
      return {
        content: [{ type: "text", text: result.delivered ? `Message sent to ${params.recipient}.` : `Message for operation ${params.operation_id} was already delivered to ${params.recipient}.` }],
        details: { delivered: result.delivered, message: result.message, recipient: params.recipient },
      };
    },
  });

  pi.registerTool({
    name: "broadcast_message_once",
    label: "Broadcast Message Once",
    description: "Idempotently broadcast a message using operation_id/workflow_run_id metadata.",
    parameters: Type.Object({
      team_name: Type.String(),
      content: Type.String(),
      summary: Type.String(),
      operation_id: Type.String(),
      workflow_run_id: Type.Optional(Type.String()),
      color: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const results = await messaging.broadcastMessageOnce(params.team_name, options.agentName, params.content, params.summary, {
        operationId: params.operation_id,
        workflowRunId: params.workflow_run_id,
        color: params.color,
        metadata: { operationId: params.operation_id, ...(params.workflow_run_id ? { workflowRunId: params.workflow_run_id } : {}) },
      });
      const deliveredCount = results.filter(result => result.delivered).length;
      return {
        content: [{ type: "text", text: `Broadcast delivered to ${deliveredCount}/${results.length} recipient(s); existing messages were reused for the rest.` }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "request_read_helper",
    label: "Request Read Helper",
    description: "Queue a read-only helper request for the current write agent. The lead runtime starts the helper outside the writer process; the helper's full report is delivered back to the requester and team-lead receives only a short done notification.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
      name: Type.Optional(Type.String({ description: "Optional helper name. Defaults to '<requester>-reader'." })),
      prompt: Type.String({ description: "The read-only mission. The helper's final answer becomes the report sent back to the requester." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the helper. Defaults to the requester cwd or current cwd." })),
      model: Type.Optional(Type.String({ description: "Optional fully qualified provider/model. Defaults to the requester/team model." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const targetTeamName = options.requireTeamContext(params.team_name);
      if (!options.isTeammate) {
        return {
          content: [{ type: "text", text: "You are the team lead. Use spawn_teammate for general read agents, or ask a write agent to call request_read_helper when it needs a private helper report." }],
          details: { leadOnly: true },
        };
      }

      const config = await teams.readConfig(targetTeamName);
      const requester = config.members.find(member => member.name === options.agentName);
      if (!requester) throw new Error(`Requester ${options.agentName} is not a member of team ${targetTeamName}.`);
      if ((requester.role ?? "write") !== "write") throw new Error("request_read_helper is only available to write agents.");
      if (!workflowAllowsReadHelper(requester)) {
        const workflowRunId = memberWorkflowRunId(requester);
        throw new Error(`request_read_helper is disabled for workflow-spawned agents${workflowRunId ? ` (workflow_run_id=${workflowRunId})` : ""}. Declare helper fanout in the workflow or ask team-lead to spawn an explicit workflow assignment.`);
      }

      const pendingHelpers = await listReadHelperQueue(targetTeamName);
      const queuedNames = pendingHelpers.map(item => item.name);
      const safeName = params.name ? paths.sanitizeName(String(params.name)) : uniqueGeneratedHelperName(config, options.agentName, queuedNames);
      const existingMember = config.members.find(member => member.name === safeName);
      if (existingMember) throw new Error(`Teammate ${safeName} already exists in team ${targetTeamName}. Choose a different helper name.`);
      if (queuedNames.includes(safeName)) throw new Error(`Read helper request ${safeName} is already queued for team ${targetTeamName}. Choose a different helper name.`);

      const chosenModel = params.model || requester.model || config.defaultModel;
      if (!chosenModel) throw new Error("No model available for read helper. Pass a fully qualified model or create the team with a default model.");
      const [provider, modelId] = String(chosenModel).split("/", 2);
      if (!provider || !modelId || !ctx.modelRegistry?.find?.(provider, modelId)) {
        throw new Error(`Read helper model \"${chosenModel}\" is not available. Pass a fully qualified available model.`);
      }

      const queued = await enqueueReadHelperRequest(targetTeamName, {
        requester: options.agentName,
        name: safeName,
        prompt: params.prompt,
        cwd: params.cwd || requester.cwd || ctx.cwd,
        model: chosenModel,
        thinking: params.thinking || requester.thinking,
      });

      return {
        content: [{ type: "text", text: `Read helper request ${safeName} accepted. Stop now and wait for the extension wake; do not call read_inbox until you are woken. The helper must send the full report to ${options.agentName}'s inbox before it stops.` }],
        details: { queued: true, queueId: queued.id, teamName: targetTeamName, helperName: safeName, requester: options.agentName, reportRecipient: options.agentName, leadNotificationRecipient: "team-lead" },
      };
    },
  });

  pi.registerTool({
    name: "request_teammate",
    label: "Request Teammate",
    description: "Ask the team lead to spawn a teammate. Teammates cannot spawn, promote, or create agents directly.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
      name: Type.Optional(Type.String({ description: "Suggested teammate name." })),
      prompt: Type.String({ description: "The mission the lead should give the teammate if approved." }),
      role: Type.Optional(StringEnum(["read", "write"] as const, { description: "Requested role. Defaults to read unless the lead chooses otherwise." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the requested teammate." })),
      category: Type.Optional(Type.String({ description: "Optional category preset name." })),
      model: Type.Optional(Type.String({ description: "Optional fully qualified provider/model." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
      reason: Type.Optional(Type.String({ description: "Why another teammate is needed." })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!options.isTeammate) {
        return {
          content: [{ type: "text", text: "You are the team lead. Use spawn_teammate directly when you decide another agent is needed." }],
          details: { leadOnly: true },
        };
      }
      return requestLeadForTeammateSpawn(options, {
        action: "spawn_teammate",
        params,
        reason: params.reason,
      });
    },
  });

  pi.registerTool({
    name: "write_shared_memory",
    label: "Write Shared Memory",
    description: "Write or replace a team-shared memory entry by key. Use for durable coordination facts within the current team.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.String(), value: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const entry = await sharedMemory.writeSharedMemory(params.team_name, options.agentName, params.key, params.value);
      return { content: [{ type: "text", text: `Shared memory '${entry.key}' saved.` }], details: { entry } };
    },
  });

  pi.registerTool({
    name: "read_shared_memory",
    label: "Read Shared Memory",
    description: "Read team-shared memory entries. Omit key to list all entries.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, params: any) {
      const entries = await sharedMemory.readSharedMemory(params.team_name, params.key);
      const text = entries.length > 0
        ? entries.map(entry => `${entry.key} (${entry.author}, ${new Date(entry.updatedAt).toISOString()}):\n${entry.value}`).join("\n\n")
        : params.key ? `No shared memory entry for '${params.key}'.` : "No shared memory entries.";
      return { content: [{ type: "text", text }], details: { entries } };
    },
  });

  pi.registerTool({
    name: "delete_shared_memory",
    label: "Delete Shared Memory",
    description: "Delete one team-shared memory entry by key.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const entry = await sharedMemory.deleteSharedMemory(params.team_name, params.key);
      if (!entry) throw new Error(`Shared memory entry '${params.key}' not found.`);
      return { content: [{ type: "text", text: `Shared memory '${entry.key}' deleted.` }], details: { entry } };
    },
  });

  pi.registerTool({
    name: "use_skill",
    label: "Use Skill",
    description: "Load a named skill file into the current agent context.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name, for example teams." }) }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        const targetTeamName = options.getTeamName();
        const config = targetTeamName ? await teams.readConfig(targetTeamName).catch(() => null) : null;
        const member = config?.members.find(item => item.name === options.agentName);
        if (member && !workflowAllowsSkill(member, params.name)) {
          const workflowRunId = memberWorkflowRunId(member);
          throw new Error(`use_skill('${params.name}') is disabled for workflow-spawned agents${workflowRunId ? ` (workflow_run_id=${workflowRunId})` : ""} unless the workflow declares the skill in member metadata.`);
        }
      }
      const file = options.resolveSkillFile(params.name, ctx.cwd);
      const content = fs.readFileSync(file, "utf-8");
      return { content: [{ type: "text", text: `Loaded skill '${params.name}' from ${file}:\n\n${content}` }], details: { name: params.name, path: file } };
    },
  });

  pi.registerTool({
    name: "read_inbox",
    label: "Read Inbox",
    description: "Read messages from an agent's inbox.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String({ description: "Whose inbox to read. Defaults to your own." })),
      unread_only: Type.Optional(Type.Boolean({ default: true })),
      mark_as_read: Type.Optional(Type.Boolean({ default: true, description: "Set false to peek without marking messages read or updating runtime readiness." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const targetAgent = params.agent_name || options.agentName;
      const markAsRead = params.mark_as_read !== false;
      if (!options.isTeammate && teams.teamExists(paths.sanitizeName(params.team_name))) {
        options.adoptTeamAsLead(paths.sanitizeName(params.team_name), ctx);
      }
      const isSelfTeammateInbox = options.isTeammate && options.getTeamName() && params.team_name === options.getTeamName() && targetAgent === options.agentName;
      const unreadBeforeRead = isSelfTeammateInbox && markAsRead
        ? await messaging.readInbox(params.team_name, targetAgent, true, false).catch(() => [])
        : [];
      const msgs = await messaging.readInbox(params.team_name, targetAgent, params.unread_only, markAsRead);

      if (isSelfTeammateInbox && markAsRead) {
        await runtime.writeRuntimeStatus(options.getTeamName()!, options.agentName, {
          lastHeartbeatAt: Date.now(),
          lastInboxReadAt: Date.now(),
          ready: true,
          currentAction: "thinking",
          activeToolName: undefined,
          lastError: undefined,
        });
        for (const message of unreadBeforeRead) {
          const from = String(message.from || "");
          if (!from || from === "team-lead" || from === "system" || from === "watchdog") continue;
          await messaging.sendPlainMessage(
            params.team_name,
            options.agentName,
            "team-lead",
            `Received helper report from ${from}; continuing.`,
            `${options.agentName} received helper report`,
            "green"
          ).catch(() => {});
        }
      }

      if (markAsRead && !options.isTeammate && params.team_name === options.getTeamName() && targetAgent === options.agentName) {
        options.resetLeadWakeNotifiedCount();
        await options.renderLeadInboxStatus();
      }

      return { content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }], details: { messages: msgs, targetAgent, markAsRead } };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderInboxMessages(result, expanded, theme);
    },
  });
}
