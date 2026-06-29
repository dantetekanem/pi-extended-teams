import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@mariozechner/pi-tui";
import * as paths from "../../src/utils/paths";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as teams from "../../src/utils/teams";
import { cleanupAgentSessionFolders, cleanupOrphanedTeams } from "../internal/session-files";
import { summarizeSessionUsage } from "../internal/session-usage";
import { formatElapsed, formatTokenCount } from "../ui/renderers";
import { isWorkflowSpawnedMember } from "../../src/utils/workflow-metadata";
import { FAVORITE_MODEL_SLOTS, loadSettings } from "../../src/utils/settings";

export interface RegisterEventsOptions {
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
  setSessionCtx(ctx: any): void;
  terminal: any;
  quietTrigger(content: string): void;
  startLeadInboxPolling(): void;
  startLeadWatchdog(): void;
  buildRoster(teamName: string): Promise<any>;
  formatRosterForPrompt(roster: any): string;
}

export function isInboxFileWatchEvent(inboxFile: string, filename: string | Buffer | null | undefined): boolean {
  const inboxBase = path.basename(inboxFile);
  const changedName = filename?.toString();
  return !changedName || changedName === inboxBase || changedName === `${inboxBase}.lock`;
}

export function registerExtensionEvents(pi: any, options: RegisterEventsOptions): void {
  let teammateWakeIfUnread: (() => Promise<void>) | null = null;
  let teammatePendingInboxWake = false;
  let teammateInboxWakeTimer: NodeJS.Timeout | null = null;

  const scheduleTeammateInboxWake = (delayMs = 0) => {
    if (!teammateWakeIfUnread || teammateInboxWakeTimer) return;
    teammateInboxWakeTimer = setTimeout(() => {
      teammateInboxWakeTimer = null;
      void teammateWakeIfUnread?.();
    }, delayMs);
  };

  const teammateRuntimeUpdates = (ctx: any, updates: Partial<runtime.AgentRuntimeStatus>, currentAssistantMessage?: any) => {
    const usage = summarizeSessionUsage(ctx, currentAssistantMessage);
    return {
      ...updates,
      ...(typeof usage.tokensUsed === "number" ? { tokensUsed: usage.tokensUsed } : {}),
    };
  };

  pi.registerMessageRenderer?.("pi-extended-teams-report", (message: any, _renderOptions: any, theme: any) => {
    const d = message.details || {};
    const meta = [
      d.elapsedMs ? formatElapsed(d.elapsedMs) : "",
      typeof d.tokens === "number" ? `${formatTokenCount(d.tokens)} tok` : "",
    ].filter(Boolean).join(" · ");
    const mark = d.ok === false ? theme.fg("warning", "✗") : theme.fg("success", "✓");
    const headline = `${mark} ${d.name || "agent"} reported${meta ? ` · ${meta}` : ""}`;
    const body = typeof message.content === "string" ? message.content : "";
    return new Text(`${theme.bold(headline)}\n\n${body}`, 0, 0);
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    paths.ensureDirs();
    // Local-only janitor pass: no model calls, no agent wakes. This prevents
    // forced-shutdown leftovers (team dirs, debug.log, runtime files, pid files)
    // from accumulating across Pi sessions.
    cleanupOrphanedTeams(options.terminal, { maxAgeMs: 24 * 60 * 60 * 1000 });
    cleanupAgentSessionFolders(24 * 60 * 60 * 1000);
    options.setSessionCtx(ctx);
    const teamName = options.getTeamName();

    if (!options.isTeammate) {
      const settings = loadSettings({ projectDir: ctx.cwd });
      const configuredLevels = FAVORITE_MODEL_SLOTS.filter((slot) => {
        const config = settings.favoriteModels[slot];
        return !!config?.model && !!config.thinking;
      });
      if (configuredLevels.length === 0) {
        ctx.ui?.notify?.(
          "No agent levels are configured. Define them with /agents-favorite-models before spawning agents. See TIPS.md for level examples.",
          "warning"
        );
      }
    }

    if (options.isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${options.agentName}.pid`);
        fs.mkdirSync(path.dirname(pidFile), { recursive: true });
        fs.writeFileSync(pidFile, process.pid.toString());
        await runtime.writeRuntimeStatus(teamName, options.agentName, {
          pid: process.pid,
          startedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          ready: false,
          currentAction: "starting",
          activeToolName: undefined,
          lastError: undefined,
        });
      }
      ctx.ui.notify(`Teammate: ${options.agentName} (Team: ${teamName})`, "info");

      if (options.terminal) {
        const fullTitle = teamName ? `${teamName}: ${options.agentName}` : options.agentName;
        const setIt = () => {
          if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
          options.terminal.setTitle(fullTitle);
        };
        setIt();
        setTimeout(setIt, 500);
        setTimeout(setIt, 2000);
        setTimeout(setIt, 5000);
      }

      setTimeout(() => {
        options.quietTrigger("read_inbox to get your instructions, then begin your work.");
      }, 1000);

      if (teamName) {
        let wakeInFlight = false;
        const wakeIfUnread = async () => {
          if (wakeInFlight) {
            teammatePendingInboxWake = true;
            scheduleTeammateInboxWake(250);
            return;
          }
          if (!ctx.isIdle()) {
            teammatePendingInboxWake = true;
            scheduleTeammateInboxWake(250);
            return;
          }
          wakeInFlight = true;
          teammatePendingInboxWake = false;
          try {
            const unread = await messaging.readInbox(teamName, options.agentName, true, false);
            await runtime.writeRuntimeStatus(teamName, options.agentName, {
              lastHeartbeatAt: Date.now(),
            });
            if (unread.length > 0) {
              options.quietTrigger(`You have ${unread.length} new inbox message(s). Read them with read_inbox and act.`);
            }
          } catch (e) {
            await runtime.writeRuntimeStatus(teamName, options.agentName, {
              lastHeartbeatAt: Date.now(),
              lastError: runtime.createRuntimeError(e),
            });
          } finally {
            wakeInFlight = false;
            if (teammatePendingInboxWake) {
              scheduleTeammateInboxWake(ctx.isIdle() ? 0 : 250);
            }
          }
        };
        teammateWakeIfUnread = wakeIfUnread;

        setInterval(wakeIfUnread, 30000);
        try {
          const inboxFile = paths.inboxPath(teamName, options.agentName);
          fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
          fs.watch(path.dirname(inboxFile), (_eventType, filename) => {
            if (isInboxFileWatchEvent(inboxFile, filename)) {
              scheduleTeammateInboxWake();
            }
          });
        } catch {
          // fs.watch is best-effort; the 30s poll remains a fallback.
        }
      }
    } else if (teamName) {
      options.startLeadInboxPolling();
      options.startLeadWatchdog();
    }
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${options.agentName}` : options.agentName;
      if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
      if (options.terminal) options.terminal.setTitle(fullTitle);
      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, options.agentName, teammateRuntimeUpdates(ctx, {
          lastHeartbeatAt: Date.now(),
          currentAction: "thinking",
          activeToolName: undefined,
        }));
      }
    }
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate && teamName) {
      await runtime.writeRuntimeStatus(teamName, options.agentName, teammateRuntimeUpdates(ctx, {
        lastHeartbeatAt: Date.now(),
        currentAction: "working",
        activeToolName: event?.toolName,
      }));
    }
  });

  pi.on("tool_execution_end", async (_event: any, ctx: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate && teamName) {
      await runtime.writeRuntimeStatus(teamName, options.agentName, teammateRuntimeUpdates(ctx, {
        lastHeartbeatAt: Date.now(),
        currentAction: "thinking",
        activeToolName: undefined,
      }));
    }
  });

  pi.on("message_end", async (event: any, ctx: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate && teamName && event.message?.role === "assistant") {
      await runtime.writeRuntimeStatus(teamName, options.agentName, teammateRuntimeUpdates(ctx, {
        lastHeartbeatAt: Date.now(),
      }, event.message));
    }
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate && teamName) {
      await runtime.writeRuntimeStatus(teamName, options.agentName, teammateRuntimeUpdates(ctx, {
        lastHeartbeatAt: Date.now(),
        currentAction: "thinking",
        activeToolName: undefined,
      }));
    }
    if (options.isTeammate && teammatePendingInboxWake && teammateWakeIfUnread) {
      // Pi may emit turn_end before ctx.isIdle() flips to true. Defer the wake
      // slightly so helper reports delivered during the writer's turn resume the
      // writer immediately instead of waiting for the 30s fallback interval.
      scheduleTeammateInboxWake(100);
    }
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event: any) => {
    const teamName = options.getTeamName();
    if (options.isTeammate && firstTurn) {
      firstTurn = false;

      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, options.agentName, {
          lastHeartbeatAt: Date.now(),
          ready: true,
          currentAction: "thinking",
          activeToolName: undefined,
        });
      }

      let modelInfo = "";
      let roleSpecificGuidance = "";
      let rosterInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find(m => m.name === options.agentName);
          if (member && member.model) {
            modelInfo = `\nYou are currently using model: ${member.model}`;
            if (member.thinking) modelInfo += ` with thinking level: ${member.thinking}`;
            modelInfo += `. When reporting your model or thinking level, use these exact values.`;
          }
          if ((member?.role ?? "write") === "write") {
            const workflowGuard = member && isWorkflowSpawnedMember(member)
              ? "\n- Workflow mode: do not create helper fanout yourself. Ask team-lead with send_message for an explicit workflow assignment."
              : "\n- If you need read-only help, ask team-lead with send_message. The lead decides whether to spawn another agent.";
            roleSpecificGuidance = `\n\nEdit-agent rules:\n- Before editing or writing any repository file, call claim_file with every path you intend to change and wait for the claim to be granted.\n- If claim_file reports conflicts, do not edit those files; coordinate with your lead instead.${workflowGuard}\n- Release claims with release_file as soon as you are done editing those paths.\n- When your work is finished, call report_and_exit. It sends your final report, releases any remaining file claims, and shuts you down. Do not wait for the lead to kill you.`;
          } else {
            roleSpecificGuidance = `\n\nRead-agent rules:\n- You are read-only: investigate and report. Do not edit files or make any mutating changes.\n- When finished, produce your final report and stop. Do not wait for the lead to kill you.`;
          }
          rosterInfo = `\n\n${options.formatRosterForPrompt(await options.buildRoster(teamName))}\nUse this roster as a snapshot. If you need updated roster or liveness details, ask team-lead with send_message. Do not poll.`;
        } catch {
          // Ignore roster/model enrichment errors.
        }
      }

      return {
        systemPrompt: event.systemPrompt + `\n\nYou are spawned agent '${options.agentName}' in Pi session '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}\n\nCore rules for every spawned agent:\n- NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.\n- You cannot spawn, promote, or create other agents. If another agent is needed, use send_message to ask team-lead to decide and spawn.\n- Use send_message for direct communication and read_inbox when the extension wakes you or you expect a reply.\n- When your work is done, report and exit cleanly. Do not wait for the lead to shut you down.${roleSpecificGuidance}${rosterInfo}\nStart by calling read_inbox to get your initial instructions.`,
      };
    }
  });
}
