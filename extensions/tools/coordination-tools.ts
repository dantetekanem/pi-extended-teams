import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as reportEvents from "../../src/utils/report-events";
import { createFileClaimTools } from "./file-claim-tools";
import { formatInboxMessagesForModel, renderInboxMessages } from "../ui/renderers";
import { unlinkPidFile } from "../internal/session-files";
import { summarizeSessionUsage } from "../internal/session-usage";

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
    `You are a read-only helper requested by edit agent '${requester}' in Pi session '${teamName}'.`,
    "Do not edit files, claim files, install packages, start services, commit, push, deploy, or make mutating changes.",
    "Investigate only what the requester asked for. Keep the final report concise and evidence-backed.",
    "Mission:",
    prompt,
  ].join("\n\n");
}

function requireCurrentSession(options: CoordinationToolsOptions): string {
  const teamName = options.getTeamName();
  if (!teamName) throw new Error("No active agent session. Spawn an agent first.");
  return teamName;
}

export function registerCoordinationTools(pi: any, options: CoordinationToolsOptions): void {
  for (const tool of createFileClaimTools({
    agentName: options.agentName,
    getAuthorizedWriteTeam: options.requireWriteAgentTeam,
    getCurrentTeam: () => requireCurrentSession(options),
    claims,
  })) {
    pi.registerTool(tool);
  }

  pi.registerTool({
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Send a final report to the lead, release this agent's file claims, and shut down.",
    parameters: Type.Object({
      content: Type.String({ description: "Final report to send to the lead." }),
      summary: Type.Optional(Type.String({ description: "Short report summary." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const targetTeamName = requireCurrentSession(options);
      if (!options.isTeammate) throw new Error("report_and_exit is only available to spawned agents.");

      const config = await teams.readConfig(targetTeamName);
      const member = config.members.find(m => m.name === options.agentName);
      const tmuxPaneId = member?.tmuxPaneId;
      const runtimeStatus = await runtime.readRuntimeStatus(targetTeamName, options.agentName).catch(() => null);
      const sessionUsage = summarizeSessionUsage(ctx);
      const tokensUsed = typeof sessionUsage.tokensUsed === "number" ? sessionUsage.tokensUsed : runtimeStatus?.tokensUsed;
      const costUsd = sessionUsage.costUsd;
      const elapsedMs = runtimeStatus?.startedAt ? Date.now() - runtimeStatus.startedAt : undefined;
      const reportMetadata = {
        finalReport: true,
        startedAt: runtimeStatus?.startedAt,
        elapsedMs,
        tokensUsed,
        costUsd,
        model: member?.model,
        thinking: member?.thinking,
        modelSlot: member?.modelSlot,
        initialPrompt: member?.prompt,
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
        modelSlot: member?.modelSlot,
        color: member?.color,
        metadata: { ...(member?.prompt ? { initialPrompt: member.prompt } : {}), ...(member?.modelSlot ? { modelSlot: member.modelSlot } : {}) },
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

      return { content: [{ type: "text", text: `Final report sent. Released ${releasedClaims.length} file claim(s). Exiting.` }], details: { session: targetTeamName, releasedClaims } };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a direct message in the current Pi session. Spawned agents default to messaging the lead.",
    parameters: Type.Object({
      recipient: Type.Optional(Type.String({ description: "Recipient agent name. Defaults to team-lead for spawned agents." })),
      content: Type.String(),
      summary: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = requireCurrentSession(options);
      const recipient = params.recipient || (options.isTeammate ? "team-lead" : undefined);
      if (!recipient) throw new Error("recipient is required when the lead sends a message.");
      await messaging.requireRunningMessageRecipient(targetTeamName, recipient);
      await messaging.sendPlainMessage(targetTeamName, options.agentName, recipient, params.content, params.summary || "Message");
      return { content: [{ type: "text", text: `Message sent to ${recipient}.` }], details: { session: targetTeamName, recipient } };
    },
  });

  pi.registerTool({
    name: "read_inbox",
    label: "Read Inbox",
    description: "Read messages from the current Pi session inbox. Defaults to this agent's inbox.",
    parameters: Type.Object({
      agent_name: Type.Optional(Type.String({ description: "Whose inbox to read. Defaults to your own." })),
      unread_only: Type.Optional(Type.Boolean({ default: true })),
      mark_as_read: Type.Optional(Type.Boolean({ default: true, description: "Set false to peek without marking messages read." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, _ctx: any) {
      const targetTeamName = requireCurrentSession(options);
      const targetAgent = params.agent_name || options.agentName;
      const markAsRead = params.mark_as_read !== false;
      const unreadOnly = params.unread_only !== false;
      const msgs = await messaging.readInbox(targetTeamName, targetAgent, unreadOnly, markAsRead);

      if (markAsRead && options.isTeammate && targetAgent === options.agentName) {
        await runtime.writeRuntimeStatus(targetTeamName, options.agentName, {
          lastHeartbeatAt: Date.now(),
          lastInboxReadAt: Date.now(),
          ready: true,
          currentAction: "thinking",
          activeToolName: undefined,
          lastError: undefined,
        }).catch(() => {});
      }

      if (markAsRead && !options.isTeammate && targetAgent === options.agentName) {
        options.resetLeadWakeNotifiedCount();
        await options.renderLeadInboxStatus();
      }

      return { content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }], details: { session: targetTeamName, messages: msgs, targetAgent, markAsRead } };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderInboxMessages(result, expanded, theme);
    },
  });
}
