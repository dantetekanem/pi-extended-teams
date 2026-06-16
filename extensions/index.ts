import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findLeadTeamForSession, registerLeadSession, resolveSkillFile } from "./internal/session-files.js";
import { dimAnsi, pink, purple } from "./ui/ansi.js";
import { buildReadAgentIdleNudgeMessage, describeReadAgentStatus, shouldNudgeReadAgentIdle, type ReadAgentStatusDescription } from "./ui/read-agent-status.js";
import { bottomStatusWidget } from "./ui/status-widget.js";
import { runReadAgentInProcess } from "./agents/read-agent.js";
import { createWriteAgentRuntime } from "./agents/write-agent.js";
import { registerExtensionEvents } from "./events/register-events.js";
import { createLifecycleRuntime } from "./team/lifecycle.js";
import { buildRoster as buildTeamRoster, formatRosterForPrompt, releaseAllClaimsForAgent, requireTeamContext as resolveTeamContext, requireWriteAgentTeam as resolveWriteAgentTeam } from "./team/roster.js";
import { registerTeamCommand } from "./ui/team-panel.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerModelTools } from "./tools/model-tools.js";
import { registerPredefinedTools } from "./tools/predefined-tools.js";
import { registerTaskRuntimeTools } from "./tools/task-runtime-tools.js";
import { registerTeamTools } from "./tools/team-tools.js";
import { formatElapsed, formatModelLabel, formatTokenCount } from "./ui/renderers.js";
import type { CompletedAgentReport, RunningReadAgent } from "./runtime/types.js";
export { panelBgFill, framePanel, frameWidget, frameWidgetFullWidth, logWindowStart } from "./ui/frame.js";
import * as messaging from "../src/utils/messaging";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || findLeadTeamForSession();
  let teamName = detectedTeamName;

  const terminal = getTerminalAdapter();

  // Track whether lead inbox polling has been started (to avoid duplicates)
  let leadPollingStarted = false;
  let sessionCtx: any = null;
  const runningReadAgents = new Map<string, RunningReadAgent>();
  const completedAgentReports = new Map<string, CompletedAgentReport[]>();
  let readAgentStatusTimer: NodeJS.Timeout | null = null;
  let leadInboxUnreadCount = 0;
  // Highest unread count we've already nudged the lead about, so we wake once per
  // new batch of reports (not every poll) and re-wake when more arrive.
  let leadWakeNotifiedCount = 0;
  const { startWriteAgent, drainWriteQueue } = createWriteAgentRuntime({ terminal });
  const { shutdownTeammate, startLeadWatchdog } = createLifecycleRuntime({
    isTeammate,
    terminal,
    runningReadAgents,
    readAgentKey,
    isCurrentReadAgentRun,
    renderReadAgentStatus,
    drainWriteQueue,
    getSessionCwd: () => sessionCtx?.cwd,
    getTeamName: () => teamName,
  });

  function readAgentKey(targetTeamName: string, targetAgentName: string): string {
    return `${targetTeamName}:${targetAgentName}`;
  }

  function isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean {
    return runningReadAgents.get(key) === state;
  }

  function rememberCompletedAgentReport(teamName: string, report: CompletedAgentReport): void {
    const current = completedAgentReports.get(teamName) ?? [];
    const dedupeKey = `${report.source}:${report.name}:${report.completedAt}:${report.summary || ""}`;
    const next = [
      ...current.filter((item) => `${item.source}:${item.name}:${item.completedAt}:${item.summary || ""}` !== dedupeKey),
      report,
    ].sort((a, b) => b.completedAt - a.completedAt).slice(0, 50);
    completedAgentReports.set(teamName, next);
  }

  // Quietly nudge this agent's loop without cluttering the transcript. A custom
  // message with display:false still reaches the model as a user turn (see
  // convertToLlm) but is never rendered, so team coordination stays silent.
  // Falls back to a visible user message on older pi builds without sendMessage.
  function quietTrigger(content: string): void {
    const api = pi as any;
    if (typeof api.sendMessage === "function") {
      api.sendMessage(
        { customType: "pi-extended-teams-wake", content, display: false },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } else {
      pi.sendUserMessage(content);
    }
  }

  // Deliver a finished agent's report straight into the lead's main window: a
  // collapsed one-line entry (name · elapsed · tokens) that ctrl+o expands to the
  // full report. display:true also feeds the report into the lead's context as a
  // user turn (see convertToLlm), and triggerTurn makes the lead synthesize it
  // automatically — no read_inbox, no manual polling.
  function emitAgentReport(name: string, startedAt: number, tokens: number, report: string, ok: boolean): void {
    const api = pi as any;
    const details = { name, elapsedMs: Date.now() - startedAt, tokens, ok };
    if (typeof api.sendMessage === "function") {
      api.sendMessage(
        { customType: "pi-extended-teams-report", content: report, display: true, details },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } else {
      pi.sendUserMessage(`Report from ${name}:\n${report}`);
    }
  }

  function wakeLeadForInboxReports(unread: any[]): void {
    if (!teamName) return;
    const count = unread.length;

    // Track reads/decreases so a fresh batch of reports re-triggers a wake.
    if (count <= leadWakeNotifiedCount) {
      leadWakeNotifiedCount = count;
      return;
    }
    // Reports grew but the lead is busy: leave the notified count untouched so the
    // next poll (when idle) or completion retries the wake instead of dropping it.
    if (!sessionCtx?.isIdle?.()) return;

    leadWakeNotifiedCount = count;
    const label = count === 1 ? "1 team report" : `${count} team reports`;
    const it = count === 1 ? "it" : "them";
    quietTrigger(
      `${label} ready in your inbox for ${teamName}. Read ${it} now with read_inbox, summarize the findings for the user, act on any blockers, and shut down finished teammates. If you are mid-task you may finish that first. Do not sleep or poll.`
    );
  }

  function wakeLeadForIdleReadAgent(agent: RunningReadAgent, status: ReadAgentStatusDescription): void {
    if (status.idleLevel === "none") return;
    if (!shouldNudgeReadAgentIdle(agent.idleNudgeLevel, status.idleLevel)) return;
    if (sessionCtx?.isIdle && !sessionCtx.isIdle()) return;

    quietTrigger(buildReadAgentIdleNudgeMessage(agent, status));
    agent.idleNudgeLevel = status.idleLevel;
  }

  function renderReadAgentStatus() {
    if (!sessionCtx?.ui) return;

    const agents = Array.from(runningReadAgents.values());
    if (agents.length === 0) {
      sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
      sessionCtx.ui.setWidget?.("01-pi-extended-teams-readers", undefined);
      if (readAgentStatusTimer) {
        clearInterval(readAgentStatusTimer);
        readAgentStatusTimer = null;
      }
      return;
    }

    const lines = [pink(`▣ read agents running (${agents.length})  /team`)];
    const now = Date.now();
    for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const tokensUsed = agent.session?.getSessionStats().tokens.total;
        if (typeof tokensUsed === "number" && tokensUsed !== agent.tokensUsed) {
          agent.tokensUsed = tokensUsed;
          agent.lastActivityAt = now;
          agent.idleNudgeLevel = undefined;
        }
      } catch {
        // Ignore stats races while the nested session is shutting down.
      }
      const elapsed = formatElapsed(now - agent.startedAt);
      const status = describeReadAgentStatus(agent, now);
      wakeLeadForIdleReadAgent(agent, status);
      const modelLabel = formatModelLabel(agent.model, agent.thinking);
      const detail = [modelLabel, elapsed, `${formatTokenCount(agent.tokensUsed)} tok`, status.detail].filter(Boolean).join(" · ");
      lines.push(
        `${purple("  ├─")} ${pink(agent.name)} ${purple(status.label)} ${dimAnsi(detail)}`
      );
    }
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("01-pi-extended-teams-readers", bottomStatusWidget(lines), { placement: "belowEditor" });
  }

  function ensureReadAgentStatusTicker() {
    if (readAgentStatusTimer) return;
    readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    renderReadAgentStatus();
  }

  async function renderLeadInboxStatus() {
    if (!sessionCtx?.ui) return;
    if (!teamName) {
      sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", undefined);
      return;
    }

    // Authoritative: read actual unread, keep the count in sync, and clear the
    // widget when there is nothing pending so finished reports leave the bar.
    const unread = await messaging.readInbox(teamName, agentName, true, false).catch(() => []);
    leadInboxUnreadCount = unread.length;
    if (unread.length === 0) {
      sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", undefined);
      return;
    }

    const lines = [pink(`▣ team reports ready (${unread.length})  read_inbox`)];
    for (const message of unread.slice(-5)) {
      const from = String(message.from || "unknown");
      const summary = String(message.summary || "message");
      lines.push(`${purple("  ├─")} ${pink(from)} ${dimAnsi(summary)}`);
    }
    if (unread.length > 5) lines.push(`${purple("  ├─")} ${dimAnsi(`${unread.length - 5} older unread report(s)`)}`);
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", bottomStatusWidget(lines), { placement: "belowEditor" });
  }

  function requireTeamContext(explicitTeamName?: string): string {
    return resolveTeamContext(teamName, explicitTeamName);
  }

  async function requireWriteAgentTeam(): Promise<string> {
    return resolveWriteAgentTeam(teamName, isTeammate, agentName);
  }

  async function buildRoster(teamName: string) {
    return buildTeamRoster(teamName, { terminal, runningReadAgents, readAgentKey });
  }

  /**
   * Start inbox polling for the team lead.
   * Called when a team is created or when the lead reconnects to an existing team.
   * Requires sessionCtx to be set (from session_start).
   */
  function startLeadInboxPolling() {
    if (leadPollingStarted || isTeammate || !sessionCtx) return;
    leadPollingStarted = true;

    setInterval(async () => {
      if (!teamName) return;
      if (sessionCtx.isIdle()) {
        try {
          const unread = await messaging.readInbox(teamName, agentName, true, false);
          await renderLeadInboxStatus();
          // Retry any wake that was deferred while the lead was busy. Internal
          // gating ensures a batch of reports nudges at most once.
          wakeLeadForInboxReports(unread);
        } catch {
          // Ignore errors for lead polling
        }
      }
    }, 30000);
  }

  // Make this session the active lead for `name`: set the current team, register
  // the lead session, and start quiet background maintenance. Idempotent. Without
  // this, operating on an existing/reconnected team leaves `teamName` unset, which
  // silently breaks /team, the inbox poll, and report wakeups.
  function adoptTeamAsLead(name: string): void {
    if (isTeammate || !name) return;
    if (teamName !== name) {
      teamName = name;
      registerLeadSession(name);
    }
    startLeadInboxPolling();
    startLeadWatchdog();
  }

  registerExtensionEvents(pi, {
    isTeammate,
    agentName,
    getTeamName: () => teamName,
    setSessionCtx: (ctx: any) => { sessionCtx = ctx; },
    terminal,
    quietTrigger,
    startLeadInboxPolling,
    startLeadWatchdog,
    buildRoster,
    formatRosterForPrompt,
  });

  registerTeamCommand(pi, {
    getTeamName: () => teamName,
    getLeadInboxUnreadCount: () => leadInboxUnreadCount,
    runningReadAgents,
    completedAgentReports,
    readAgentKey,
    terminal,
    shutdownTeammate,
  });

  function readAgentOptions() {
    return {
      isTeammate,
      getTeamName: () => teamName,
      runningReadAgents,
      readAgentKey,
      isCurrentReadAgentRun,
      ensureReadAgentStatusTicker,
      renderReadAgentStatus,
      rememberCompletedAgentReport,
      emitAgentReport,
      releaseAllClaimsForAgent,
    };
  }

  registerModelTools(pi);
  registerTeamTools(pi, {
    terminal,
    runningReadAgents,
    readAgentKey,
    isCurrentReadAgentRun,
    renderReadAgentStatus,
    readAgentOptions,
    runReadAgentInProcess,
    startWriteAgent,
    shutdownTeammate,
    adoptTeamAsLead,
    buildRoster,
  });

  registerCoordinationTools(pi, {
    agentName,
    isTeammate,
    terminal,
    getTeamName: () => teamName,
    requireWriteAgentTeam,
    requireTeamContext,
    releaseAllClaimsForAgent,
    drainWriteQueue,
    resolveSkillFile,
    adoptTeamAsLead,
    renderLeadInboxStatus,
    resetLeadWakeNotifiedCount: () => { leadWakeNotifiedCount = 0; },
  });

  registerTaskRuntimeTools(pi, {
    terminal,
    runningReadAgents,
    readAgentKey,
    shutdownTeammate,
    releaseAllClaimsForAgent,
  });

  registerPredefinedTools(pi, {
    terminal,
    adoptTeamAsLead,
  });

}
