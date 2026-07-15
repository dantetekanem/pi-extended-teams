import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as reportEvents from "../../src/utils/report-events";
import { canonicalPersistedModelSlot } from "../../src/utils/settings";
import { createFileClaimTools } from "./file-claim-tools";
import { formatInboxMessagesForModel, renderInboxMessages } from "../ui/renderers";
import { unlinkPidFile } from "../internal/session-files";
import { summarizeSessionUsage } from "../internal/session-usage";
import { closePersistedRecipient } from "../team/recipient-closure";
import {
  generateExtensionInstanceId,
  withLifecycleTombstoneLock,
} from "../../src/utils/lifecycle-tombstone";

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
  deliverMessageToActiveAgent?(teamName: string, recipient: string, content: string): Promise<boolean>;
  extensionInstanceId?: string;
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
  const extensionInstanceId = options.extensionInstanceId ?? generateExtensionInstanceId();
  const pendingWriterFinalization = new Map<string, { teamName: string; agentName: string; runId: string }>();

  pi.on?.("session_shutdown", async () => {
    const pending = Array.from(pendingWriterFinalization.values());
    for (const item of pending) {
      let cleared = false;
      let failed = false;
      await withLifecycleTombstoneLock(item.teamName, item.agentName, async lifecycleLock => {
        const fence = lifecycleLock.read();
        if (fence.status !== "occupied" || fence.tombstone.runId !== item.runId) return;

        lifecycleLock.updateMatching(item.runId, { phase: "finalizing", error: undefined });
        try {
          const config = teams.teamExists(item.teamName) ? await teams.readConfig(item.teamName) : null;
          const currentMember = config?.members.find(member => member.name === item.agentName);
          if (currentMember && currentMember.lifecycleRunId !== item.runId) {
            throw new Error(`Refusing to remove replacement run ${currentMember.lifecycleRunId || "unknown"} of ${item.agentName}.`);
          }

          const currentRuntime = await runtime.readRuntimeStatus(item.teamName, item.agentName);
          if (currentRuntime && currentRuntime.lifecycleRunId !== item.runId) {
            throw new Error(`Refusing to remove replacement runtime run ${currentRuntime.lifecycleRunId || "unknown"} of ${item.agentName}.`);
          }

          const pidFile = path.join(paths.teamDir(item.teamName), `${item.agentName}.pid`);
          const pidFileExisted = fs.existsSync(pidFile);
          const pidFileUnlinked = unlinkPidFile(pidFile);
          if (pidFileExisted && (!pidFileUnlinked || fs.existsSync(pidFile))) {
            throw new Error(`Could not remove PID file for ${item.agentName} run ${item.runId}.`);
          }
          if (currentRuntime) {
            const removedRuntime = await runtime.deleteRuntimeStatusUnderLifecycleLock(
              item.teamName,
              item.agentName,
              item.runId,
            );
            if (!removedRuntime) throw new Error(`Could not remove runtime for ${item.agentName} run ${item.runId}.`);
          }
          if (currentMember) {
            const removedMember = await teams.removeMemberMatchingRun(item.teamName, item.agentName, item.runId);
            if (!removedMember) throw new Error(`Could not remove member ${item.agentName} run ${item.runId}.`);
          }

          const remainingMember = teams.teamExists(item.teamName)
            ? (await teams.readConfig(item.teamName)).members.find(member => member.name === item.agentName)
            : undefined;
          if (remainingMember) {
            throw new Error(`Member ${item.agentName} still exists after run ${item.runId} cleanup.`);
          }
          if (fs.existsSync(paths.runtimeStatusPath(item.teamName, item.agentName))) {
            throw new Error(`Runtime for ${item.agentName} still exists after run ${item.runId} cleanup.`);
          }

          if (!lifecycleLock.clearMatching(item.runId)) {
            throw new Error(`Lifecycle fence changed before final clear for ${item.agentName} run ${item.runId}.`);
          }
          cleared = true;
        } catch (error) {
          failed = true;
          lifecycleLock.updateMatching(item.runId, {
            phase: "cleanup_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      if (cleared || failed) {
        pendingWriterFinalization.delete(`${item.teamName}:${item.agentName}`);
      }
      if (cleared) {
        void options.drainWriteQueue(item.teamName).catch(() => {});
      }
    }
  });

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
      if (!member) throw new Error(`Agent ${options.agentName} is not active in ${targetTeamName}.`);
      const processRunId = process.env.PI_LIFECYCLE_RUN_ID;
      const runId = await teams.ensureMemberLifecycleRunId(targetTeamName, options.agentName, processRunId);
      if (processRunId && runId !== processRunId) {
        throw new Error(`Refusing stale report run ${processRunId} for ${options.agentName}; current roster run is ${runId}.`);
      }
      member.lifecycleRunId = runId;
      let runtimeStatus = await runtime.readRuntimeStatus(targetTeamName, options.agentName).catch(() => null);
      if (runtimeStatus?.lifecycleRunId && runtimeStatus.lifecycleRunId !== runId) {
        throw new Error(`Refusing to report from stale run ${runId}; runtime status belongs to ${runtimeStatus.lifecycleRunId}.`);
      }
      if (runtimeStatus && !runtimeStatus.lifecycleRunId) {
        runtimeStatus = await runtime.writeRuntimeStatus(targetTeamName, options.agentName, runId, {});
      }
      await closePersistedRecipient(targetTeamName, options.agentName, runId, {
        removeOnFailure: true,
        role: (member.role ?? "write") === "read" ? "read" : "write",
        reason: "quit",
        extensionInstanceId,
      });
      pendingWriterFinalization.set(`${targetTeamName}:${options.agentName}`, {
        teamName: targetTeamName,
        agentName: options.agentName,
        runId,
      });
      const sessionUsage = summarizeSessionUsage(ctx);
      const tokensUsed = typeof sessionUsage.tokensUsed === "number" ? sessionUsage.tokensUsed : runtimeStatus?.tokensUsed;
      const costUsd = sessionUsage.costUsd;
      const elapsedMs = runtimeStatus?.startedAt ? Date.now() - runtimeStatus.startedAt : undefined;
      const modelSlot = canonicalPersistedModelSlot(member?.modelSlot);
      const reportMetadata = {
        finalReport: true,
        startedAt: runtimeStatus?.startedAt,
        elapsedMs,
        tokensUsed,
        costUsd,
        model: member?.model,
        thinking: member?.thinking,
        modelSlot,
        initialPrompt: member?.prompt,
      };

      let releasedClaims: string[] = [];
      try {
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
          modelSlot,
          color: member?.color,
          metadata: { ...(member?.prompt ? { initialPrompt: member.prompt } : {}), ...(modelSlot ? { modelSlot } : {}) },
        }).catch(() => {});
        releasedClaims = await options.releaseAllClaimsForAgent(targetTeamName, options.agentName);
      } catch (error) {
        pendingWriterFinalization.delete(`${targetTeamName}:${options.agentName}`);
        await withLifecycleTombstoneLock(targetTeamName, options.agentName, async lifecycleLock => {
          lifecycleLock.updateMatching(runId, {
            phase: "cleanup_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        throw error;
      }

      setTimeout(() => {
        try { ctx.shutdown(); } catch { process.exit(0); }
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
      const deliveredDirectly = await options.deliverMessageToActiveAgent?.(targetTeamName, recipient, params.content) === true;
      if (!deliveredDirectly) {
        await messaging.sendPlainMessageIfRunning(targetTeamName, options.agentName, recipient, params.content, params.summary || "Message");
      }
      return {
        content: [{ type: "text", text: `Message sent to ${recipient}.` }],
        details: { session: targetTeamName, recipient, delivery: deliveredDirectly ? "active-session" : "inbox" },
      };
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
        const config = await teams.readConfig(targetTeamName).catch(() => null);
        const lifecycleRunId = config?.members.find(member => member.name === options.agentName)?.lifecycleRunId;
        if (lifecycleRunId) {
          await runtime.writeRuntimeStatus(targetTeamName, options.agentName, lifecycleRunId, {
            lastHeartbeatAt: Date.now(),
            lastInboxReadAt: Date.now(),
            ready: true,
            currentAction: "thinking",
            activeToolName: undefined,
            lastError: undefined,
          }).catch(() => {});
        }
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
