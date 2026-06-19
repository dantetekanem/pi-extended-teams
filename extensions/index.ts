import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findLeadTeamForSession, getPiSessionId, registerLeadSession, resolveSkillFile } from "./internal/session-files.js";
import { buildReadAgentIdleNudgeMessage, describeReadAgentStatus, shouldNudgeReadAgentIdle, type ReadAgentStatusDescription } from "./ui/read-agent-status.js";
import { teamActivityStatusWidget, type TeamActivityStatusEntry, type TeamActivityStatusSnapshot } from "./ui/status-widget.js";
import { runReadAgentInProcess } from "./agents/read-agent.js";
import { createWriteAgentRuntime } from "./agents/write-agent.js";
import { registerExtensionEvents } from "./events/register-events.js";
import { createLifecycleRuntime } from "./team/lifecycle.js";
import { buildRoster as buildTeamRoster, formatRosterForPrompt, releaseAllClaimsForAgent, requireTeamContext as resolveTeamContext, requireWriteAgentTeam as resolveWriteAgentTeam } from "./team/roster.js";
import { registerWriterScreenShortcut } from "./team/writer-screens.js";
import { registerTeamCommand } from "./ui/team-panel.js";
import { buildReadHelperPrompt, registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerModelTools } from "./tools/model-tools.js";
import { registerPredefinedTools } from "./tools/predefined-tools.js";
import { registerTaskRuntimeTools } from "./tools/task-runtime-tools.js";
import { registerTeamTools } from "./tools/team-tools.js";
import { getCurrentQualifiedModel } from "./internal/model-selection.js";
import { formatElapsed, formatModelLabel, formatTokenCount } from "./ui/renderers.js";
import type { CompletedAgentReport, RunningReadAgent } from "./runtime/types.js";
export { panelBgFill, framePanel, frameWidget, frameWidgetFullWidth, logWindowStart } from "./ui/frame.js";
import * as messaging from "../src/utils/messaging";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import * as teamPaths from "../src/utils/paths";
import { dequeueReadHelperRequest } from "../src/utils/read-helper-queue";
import type { Member } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;

  // Teammates are explicitly bound by PI_TEAM_NAME. Lead sessions are adopted
  // later at session_start only when the persisted Pi session id matches.
  let teamName = envTeamName;

  const terminal = getTerminalAdapter();

  // Track whether lead inbox/helper polling has been started (to avoid duplicates)
  let leadPollingStarted = false;
  let readHelperQueueWatchedTeam: string | null = null;
  let readHelperQueueWatcher: fs.FSWatcher | null = null;
  let readHelperQueueFallbackStarted = false;
  let readHelperQueueDraining = false;
  let readHelperQueueDrainPending = false;
  let sessionCtx: any = null;
  const runningReadAgents = new Map<string, RunningReadAgent>();
  const completedAgentReports = new Map<string, CompletedAgentReport[]>();
  let readAgentStatusTimer: NodeJS.Timeout | null = null;
  let teamActivityStatusSnapshot: TeamActivityStatusSnapshot | null = null;
  let teamActivityWidgetMounted = false;
  let teamActivityWidgetTui: { requestRender?: () => void } | null = null;
  let activePromptBuildTeamName: string | null = null;
  let leadInboxWidgetCleared = false;
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

  function getTeamPanelName(): string | undefined {
    if (teamName) return teamName;
    if (activePromptBuildTeamName && teams.teamExists(activePromptBuildTeamName)) return activePromptBuildTeamName;
    return undefined;
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
  function emitAgentReport(reportTeamName: string, name: string, startedAt: number, tokens: number, report: string, ok: boolean): void {
    const api = pi as any;
    const details = { name, elapsedMs: Date.now() - startedAt, tokens, ok };
    pi.events?.emit?.("pi-extended-teams:agent-report", { teamName: reportTeamName, name, startedAt, tokens, report, ok, details });

    // pi-prompt prompt-build teams are extension-controlled fanout jobs. Their
    // reports are consumed by pi-prompt via the event above and must not be
    // injected as visible user turns, otherwise the main agent starts answering
    // each branch report and can ask unrelated follow-up questions.
    if (reportTeamName.startsWith("prompt-build-")) return;

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

  function clearLeadInboxWidgetOnce(): void {
    if (leadInboxWidgetCleared) return;
    leadInboxWidgetCleared = true;
    sessionCtx?.ui?.setWidget?.("02-pi-extended-teams-inbox", undefined);
  }

  function renderReadAgentStatus() {
    void renderTeamActivityStatus();
  }

  function isTeamActivityExpanded(): boolean {
    return !!sessionCtx?.ui?.getToolsExpanded?.();
  }

  function mountTeamActivityWidget(): void {
    if (teamActivityWidgetMounted || !sessionCtx?.ui?.setWidget) return;
    teamActivityWidgetMounted = true;
    sessionCtx.ui.setWidget(
      "01-pi-extended-teams-readers",
      (tui: any) => {
        teamActivityWidgetTui = tui;
        return teamActivityStatusWidget(() => teamActivityStatusSnapshot, isTeamActivityExpanded);
      },
      { placement: "aboveEditor" }
    );
  }

  function updateTeamActivityWidget(snapshot: TeamActivityStatusSnapshot): void {
    teamActivityStatusSnapshot = snapshot;
    mountTeamActivityWidget();
    teamActivityWidgetTui?.requestRender?.();
  }

  function clearTeamActivityWidget(): void {
    teamActivityStatusSnapshot = null;
    teamActivityWidgetMounted = false;
    teamActivityWidgetTui = null;
    sessionCtx?.ui?.setWidget?.("01-pi-extended-teams-readers", undefined);
  }

  async function renderTeamActivityStatus() {
    if (!sessionCtx?.ui) return;

    const now = Date.now();
    const readAgents = Array.from(runningReadAgents.values())
      .sort((a, b) => a.name.localeCompare(b.name));
    const activeWriteMembers = teamName
      ? (await teams.readConfig(teamName).catch(() => null))?.members
        ?.filter(member => member.name !== "team-lead" && (member.role ?? "write") !== "read")
        ?.filter(member => !!(member.tmuxPaneId && terminal?.isAlive?.(member.tmuxPaneId))) ?? []
      : [];
    const unreadLeadMessages = teamName ? await messaging.readInbox(teamName, agentName, true, false).catch(() => []) : [];
    leadInboxUnreadCount = unreadLeadMessages.length;
    clearLeadInboxWidgetOnce();

    if ((readAgents.length > 0 || activeWriteMembers.length > 0) && !readAgentStatusTimer) {
      readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    }

    if (readAgents.length === 0 && activeWriteMembers.length === 0) {
      sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
      clearTeamActivityWidget();
      sessionCtx.ui.setWidget?.("01-pi-extended-teams-status", undefined);
      if (readAgentStatusTimer) {
        clearInterval(readAgentStatusTimer);
        readAgentStatusTimer = null;
      }
      return;
    }

    const activeCount = readAgents.length + activeWriteMembers.length;
    const entries: TeamActivityStatusEntry[] = [];

    for (const member of activeWriteMembers.sort((a, b) => a.name.localeCompare(b.name))) {
      const runtimeStatus = await runtime.readRuntimeStatus(teamName!, member.name).catch(() => null);
      const elapsed = formatElapsed(now - (runtimeStatus?.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const tokens = typeof runtimeStatus?.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const action = runtimeStatus?.activeToolName
        ? `${runtimeStatus.currentAction || "working"}: ${runtimeStatus.activeToolName}`
        : runtimeStatus?.currentAction || "running";
      const screen = member.windowId ? `${member.windowId}/${member.tmuxPaneId}` : member.tmuxPaneId;
      const detail = [screen, modelLabel, elapsed, tokens, action].filter(Boolean).join(" · ");
      entries.push({ name: member.name, role: "write", status: "bg", detail });
    }

    for (const agent of readAgents) {
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
      entries.push({ name: agent.name, role: "read", status: status.label, detail });
    }

    sessionCtx.ui.setWidget?.("01-pi-extended-teams-status", undefined);
    updateTeamActivityWidget({
      activeCount,
      readCount: readAgents.length,
      writeCount: activeWriteMembers.length,
      unreadCount: leadInboxUnreadCount,
      entries,
      updatedAt: now,
    });
  }

  function ensureReadAgentStatusTicker() {
    if (readAgentStatusTimer) return;
    readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    renderReadAgentStatus();
  }

  async function renderLeadInboxStatus() {
    clearLeadInboxWidgetOnce();
    await renderTeamActivityStatus();
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

  async function drainReadHelperQueueOnce() {
    if (isTeammate || !sessionCtx || !teamName) return;
    if (readHelperQueueDraining) {
      readHelperQueueDrainPending = true;
      return;
    }
    readHelperQueueDraining = true;
    try {
      for (let drained = 0; drained < 10 && teamName; drained++) {
        const queued = await dequeueReadHelperRequest(teamName);
        if (!queued) break;

        try {
          const config = await teams.readConfig(queued.teamName);
          if (config.members.some(member => member.name === queued.name)) {
            throw new Error(`Teammate ${queued.name} already exists in team ${queued.teamName}.`);
          }
          const [provider, modelId] = String(queued.model).split("/", 2);
          const model = provider && modelId ? sessionCtx.modelRegistry?.find?.(provider, modelId) : undefined;
          if (!model) throw new Error(`Read helper model \"${queued.model}\" is not available in the lead session.`);

          const helperPrompt = buildReadHelperPrompt(queued.teamName, queued.requester, queued.prompt);
          const member: Member = {
            agentId: `${queued.name}@${queued.teamName}`,
            name: queued.name,
            agentType: "teammate",
            role: "read",
            model: queued.model,
            joinedAt: Date.now(),
            tmuxPaneId: "",
            cwd: queued.cwd,
            subscriptions: [],
            prompt: helperPrompt,
            color: "cyan",
            thinking: queued.thinking,
            requestedBy: queued.requester,
            helperKind: "read_helper",
          };

          await teams.addMember(queued.teamName, member);
          void runReadAgentInProcess(queued.teamName, member, helperPrompt, sessionCtx, readAgentOptions());
        } catch (e) {
          const message = `Read helper ${queued.name} could not start for ${queued.requester}: ${e instanceof Error ? e.message : String(e)}`;
          await messaging.sendPlainMessage(queued.teamName, queued.name, queued.requester, message, `Read helper ${queued.name} failed`, "red").catch(() => {});
          await messaging.sendPlainMessage(queued.teamName, queued.name, "team-lead", message, `Read helper ${queued.name} failed`, "red").catch(() => {});
        }
      }
    } finally {
      readHelperQueueDraining = false;
      if (readHelperQueueDrainPending) {
        readHelperQueueDrainPending = false;
        void drainReadHelperQueueOnce();
      }
    }
  }

  function startReadHelperQueueDraining() {
    if (isTeammate || !sessionCtx || !teamName) return;
    if (readHelperQueueWatchedTeam === teamName) {
      void drainReadHelperQueueOnce();
      return;
    }

    readHelperQueueWatcher?.close();
    readHelperQueueWatchedTeam = teamName;
    void drainReadHelperQueueOnce();

    try {
      const queueFile = teamPaths.readHelperQueuePath(teamName);
      fs.mkdirSync(path.dirname(queueFile), { recursive: true });
      readHelperQueueWatcher = fs.watch(path.dirname(queueFile), (_eventType, filename) => {
        if (!filename || filename.toString() === path.basename(queueFile)) {
          void drainReadHelperQueueOnce();
        }
      });
    } catch {
      readHelperQueueWatcher = null;
    }

    // Low-cost fallback for platforms where fs.watch misses an event. This does
    // no model work and only reads one small JSON queue file.
    if (!readHelperQueueFallbackStarted) {
      readHelperQueueFallbackStarted = true;
      setInterval(() => { void drainReadHelperQueueOnce(); }, 5000);
    }
  }

  /**
   * Start inbox polling for the team lead.
   * Called when a team is created or when the lead reconnects to an existing team.
   * Requires sessionCtx to be set (from session_start).
   */
  function startLeadInboxPolling() {
    if (isTeammate || !sessionCtx) return;
    startReadHelperQueueDraining();
    if (leadPollingStarted) return;
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
  function adoptTeamAsLead(name: string, ctx?: any): void {
    if (isTeammate || !name) return;
    const sessionId = getPiSessionId(ctx ?? sessionCtx);
    if (teamName !== name) {
      teamName = name;
    }
    registerLeadSession(name, sessionId);
    ensureReadAgentStatusTicker();
    startLeadInboxPolling();
    startReadHelperQueueDraining();
    startLeadWatchdog();
  }

  pi.events?.on?.("pi-prompt:prompt-build:start", async (payload: any) => {
    if (isTeammate || !sessionCtx) return;
    const requestedTeamName = teamPaths.sanitizeName(payload?.teamName || `prompt-build-${Date.now()}`);

    try {
      const prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
      activePromptBuildTeamName = requestedTeamName;
      const cwd = payload?.cwd || sessionCtx.cwd;
      const agentNamePrefix = teamPaths.sanitizeName(payload?.agentNamePrefix || "prompt-branch");
      const model = getCurrentQualifiedModel(sessionCtx);
      if (!model) {
        pi.events?.emit?.("pi-prompt:prompt-build:error", { teamName: requestedTeamName, error: "No current model available for read agents." });
        return;
      }

      if (!teams.teamExists(requestedTeamName)) {
        teams.createTeam(requestedTeamName, getPiSessionId(sessionCtx) || "local-session", "lead-agent", payload?.description || "pi-prompt prompt-build", model);
      }
      // Prompt-build teams are private fanout jobs owned by pi-prompt. Do not
      // adopt them as the lead's current team, or normal /team context and
      // bottom-status widgets get hijacked by the prompt-building run.
      pi.events?.emit?.("pi-prompt:prompt-build:progress", { teamName: requestedTeamName, status: "started", total: prompts.length, text: `building prompt — ${prompts.length} branches started` });

      for (let i = 0; i < prompts.length; i += 1) {
        const name = teamPaths.sanitizeName(`${agentNamePrefix}-${i + 1}`);
        const prompt = String(prompts[i] ?? "");
        const member: Member = {
          agentId: `${name}@${requestedTeamName}`,
          name,
          agentType: "teammate",
          role: "read",
          model,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd,
          subscriptions: [],
          prompt,
          color: "cyan",
          thinking: payload?.thinking || "high",
        };
        await teams.addMember(requestedTeamName, member);
        void runReadAgentInProcess(requestedTeamName, member, prompt, sessionCtx, readAgentOptions());
        pi.events?.emit?.("pi-prompt:prompt-build:progress", { teamName: requestedTeamName, status: "spawned", started: i + 1, total: prompts.length, text: `building prompt — ${i + 1}/${prompts.length} branches started` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.events?.emit?.("pi-prompt:prompt-build:error", { teamName: requestedTeamName, error: message });
    }
  });

  registerExtensionEvents(pi, {
    isTeammate,
    agentName,
    getTeamName: () => teamName,
    setSessionCtx: (ctx: any) => {
      sessionCtx = ctx;
      if (!isTeammate && !teamName) {
        const foundTeam = findLeadTeamForSession(getPiSessionId(ctx));
        if (foundTeam) adoptTeamAsLead(foundTeam, ctx);
      }
    },
    terminal,
    quietTrigger,
    startLeadInboxPolling,
    startLeadWatchdog,
    buildRoster,
    formatRosterForPrompt,
  });

  registerTeamCommand(pi, {
    getTeamName: getTeamPanelName,
    getLeadInboxUnreadCount: () => leadInboxUnreadCount,
    runningReadAgents,
    completedAgentReports,
    readAgentKey,
    terminal,
    shutdownTeammate,
  });

  registerWriterScreenShortcut(pi, {
    getTeamName: getTeamPanelName,
    terminal,
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
      agentName,
      quietTrigger,
      renderLeadInboxStatus,
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
    isTeammate,
    agentName,
    getTeamName: () => teamName,
    getSessionCtx: () => sessionCtx,
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
    isTeammate,
    agentName,
    getTeamName: () => teamName,
  });

}
