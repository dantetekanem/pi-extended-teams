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
import { createWriterScreenState, registerWriterScreenShortcut, removeWriterScreenTab, upsertWriterScreenTab, type ActiveWriterTab } from "./team/writer-screens.js";
import { registerTeamCommand } from "./ui/team-panel.js";
import { registerFavoriteModelsCommand } from "./ui/favorite-models-command.js";
import { buildReadHelperPrompt, registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerTaskRuntimeTools } from "./tools/task-runtime-tools.js";
import { registerTeamTools } from "./tools/team-tools.js";
import { getCurrentQualifiedModel } from "./internal/model-selection.js";
import { loadSettings, requireFavoriteModelLevel } from "../src/utils/settings";
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
  const activeWritersTabs: ActiveWriterTab[] = [];
  const writerScreenState = createWriterScreenState(activeWritersTabs);

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
  const TEAM_ACTIVITY_RENDER_DEBOUNCE_MS = 75;
  let readAgentStatusTimer: NodeJS.Timeout | null = null;
  let teamActivityStatusSnapshot: TeamActivityStatusSnapshot | null = null;
  let teamActivityStatusSnapshotSignature: string | null = null;
  let teamActivityWidgetMounted = false;
  let teamActivityWidgetTui: { requestRender?: () => void } | null = null;
  let teamActivityRenderInFlight = false;
  let teamActivityRenderDirty = false;
  let teamActivityRenderTimer: NodeJS.Timeout | null = null;
  const teamActivityRenderWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  let activePromptBuildTeamName: string | null = null;
  let leadInboxWidgetCleared = false;
  let leadInboxUnreadCount = 0;
  // Highest unread count we've already nudged the lead about, so we wake once per
  // new batch of reports (not every poll) and re-wake when more arrive.
  let leadWakeNotifiedCount = 0;
  const { startWriteAgent, drainWriteQueue } = createWriteAgentRuntime({
    terminal,
    onWriterActive: (tab) => upsertWriterScreenTab(writerScreenState, tab),
    onWriterInactive: (targetTeamName, member) => removeWriterScreenTab(writerScreenState, { teamName: targetTeamName, name: member.name, paneId: member.tmuxPaneId }),
  });
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
    onWriterInactive: (targetTeamName, member) => removeWriterScreenTab(writerScreenState, { teamName: targetTeamName, name: member.name, paneId: member.tmuxPaneId }),
  });

  function readAgentKey(targetTeamName: string, targetAgentName: string): string {
    return `${targetTeamName}:${targetAgentName}`;
  }

  function memberActivityRole(member: Member): "read" | "write" {
    if (member.role === "read" || member.role === "write") return member.role;
    return member.modelSlot?.startsWith("reading-") ? "read" : "write";
  }

  function runtimeHeartbeatIsRecent(status: runtime.AgentRuntimeStatus, now: number): boolean {
    return !!status.lastHeartbeatAt && (now - status.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
  }

  function isVisibleRuntimeOnlyMember(
    member: Member,
    runtimeStatus: runtime.AgentRuntimeStatus | null
  ): runtimeStatus is runtime.AgentRuntimeStatus {
    return member.isActive !== false && runtimeStatus?.ready === true;
  }

  function runtimeOnlyStatusLabel(status: runtime.AgentRuntimeStatus, now: number): string {
    if (!runtimeHeartbeatIsRecent(status, now)) return "stale";
    if (status.currentAction && status.currentAction !== "done") return status.currentAction;
    return status.ready ? "ready" : "running";
  }

  function runtimeOnlyActionLabel(status: runtime.AgentRuntimeStatus): string {
    if (status.activeToolName) return `${status.currentAction || "working"}: ${status.activeToolName}`;
    return status.currentAction || (status.ready ? "ready" : "running");
  }

  function runtimeOnlyHeartbeatDetail(status: runtime.AgentRuntimeStatus, now: number): string {
    return runtimeHeartbeatIsRecent(status, now) ? "" : "heartbeat stale";
  }

  function currentSessionAgentGroupName(ctx?: any): string | undefined {
    const sessionId = getPiSessionId(ctx ?? sessionCtx) || "local-session";
    return teamPaths.sanitizeName(`session-${sessionId}`);
  }

  function ensureTeamPanelName(ctx?: any): string | undefined {
    if (teamName && teams.teamExists(teamName)) return teamName;

    const sessionId = getPiSessionId(ctx ?? sessionCtx);
    const foundTeam = findLeadTeamForSession(sessionId);
    if (foundTeam) {
      adoptTeamAsLead(foundTeam, ctx);
      return foundTeam;
    }

    if (activePromptBuildTeamName && teams.teamExists(activePromptBuildTeamName)) return activePromptBuildTeamName;

    const sessionName = currentSessionAgentGroupName(ctx);
    if (!sessionName) return undefined;
    if (!teams.teamExists(sessionName)) {
      teams.createTeam(sessionName, sessionId || "local-session", "lead-agent", "Pi session agents", getCurrentQualifiedModel(ctx ?? sessionCtx));
    }
    adoptTeamAsLead(sessionName, ctx);
    return sessionName;
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

  // Deliver a finished agent's report straight into the lead's main window: an
  // always-open report entry with name, elapsed time, tokens, and the full body.
  // display:true also feeds the report into the lead's context as a
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

  function getIdleReadAgentNudgeMessage(agent: RunningReadAgent, status: ReadAgentStatusDescription): string | null {
    if (status.idleLevel === "none") return null;
    if (!shouldNudgeReadAgentIdle(agent.idleNudgeLevel, status.idleLevel)) return null;
    if (sessionCtx?.isIdle && !sessionCtx.isIdle()) return null;

    agent.idleNudgeLevel = status.idleLevel;
    return buildReadAgentIdleNudgeMessage(agent, status);
  }

  function wakeLeadForIdleReadAgents(messages: string[]): void {
    if (messages.length === 0) return;
    if (messages.length === 1) {
      quietTrigger(messages[0]);
      return;
    }

    quietTrigger([
      `${messages.length} read agents need attention:`,
      ...messages.map((message) => `- ${message}`),
    ].join("\n"));
  }

  function clearLeadInboxWidgetOnce(): void {
    if (leadInboxWidgetCleared) return;
    leadInboxWidgetCleared = true;
    sessionCtx?.ui?.setWidget?.("02-pi-extended-teams-inbox", undefined);
  }

  function renderReadAgentStatus() {
    markTeamActivityStatusDirty();
  }

  function waitForTeamActivityRender(): Promise<void> {
    return new Promise((resolve, reject) => teamActivityRenderWaiters.push({ resolve, reject }));
  }

  function settleTeamActivityRenderWaiters(error?: unknown): void {
    const waiters = teamActivityRenderWaiters.splice(0);
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function queueTeamActivityStatusRender(delayMs = TEAM_ACTIVITY_RENDER_DEBOUNCE_MS): void {
    if (teamActivityRenderTimer || teamActivityRenderInFlight) return;
    teamActivityRenderTimer = setTimeout(() => {
      teamActivityRenderTimer = null;
      void flushTeamActivityStatusRender();
    }, Math.max(0, delayMs));
  }

  function markTeamActivityStatusDirty(delayMs = TEAM_ACTIVITY_RENDER_DEBOUNCE_MS): void {
    teamActivityRenderDirty = true;
    queueTeamActivityStatusRender(delayMs);
  }

  async function renderTeamActivityStatus(): Promise<void> {
    teamActivityRenderDirty = true;
    if (teamActivityRenderTimer) {
      clearTimeout(teamActivityRenderTimer);
      teamActivityRenderTimer = null;
    }
    const promise = waitForTeamActivityRender();
    void flushTeamActivityStatusRender();
    return promise;
  }

  async function flushTeamActivityStatusRender(): Promise<void> {
    if (teamActivityRenderInFlight) return;
    if (!teamActivityRenderDirty) {
      settleTeamActivityRenderWaiters();
      return;
    }

    teamActivityRenderInFlight = true;
    let renderError: unknown;
    try {
      teamActivityRenderDirty = false;
      await renderTeamActivityStatusNow();
    } catch (error) {
      renderError = error;
    } finally {
      teamActivityRenderInFlight = false;
      if (renderError) {
        teamActivityRenderDirty = false;
        settleTeamActivityRenderWaiters(renderError);
      } else if (teamActivityRenderDirty) {
        queueTeamActivityStatusRender();
      } else {
        settleTeamActivityRenderWaiters();
      }
    }
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

  function getTeamActivitySnapshotSignature(snapshot: TeamActivityStatusSnapshot): string {
    return JSON.stringify({
      activeCount: snapshot.activeCount,
      readCount: snapshot.readCount,
      writeCount: snapshot.writeCount,
      unreadCount: snapshot.unreadCount,
      statusCounts: snapshot.statusCounts ?? {},
      entries: snapshot.entries,
    });
  }

  function updateTeamActivityWidget(snapshot: TeamActivityStatusSnapshot): void {
    const nextSignature = getTeamActivitySnapshotSignature(snapshot);
    const changed = nextSignature !== teamActivityStatusSnapshotSignature;
    teamActivityStatusSnapshot = snapshot;
    teamActivityStatusSnapshotSignature = nextSignature;
    mountTeamActivityWidget();
    if (changed) teamActivityWidgetTui?.requestRender?.();
  }

  function clearTeamActivityWidget(): void {
    teamActivityStatusSnapshot = null;
    teamActivityStatusSnapshotSignature = null;
    teamActivityWidgetMounted = false;
    teamActivityWidgetTui = null;
    sessionCtx?.ui?.setWidget?.("01-pi-extended-teams-readers", undefined);
  }

  async function renderTeamActivityStatusNow() {
    if (!sessionCtx?.ui) return;

    const now = Date.now();
    const activityTeamName = teamName || null;
    const runningAgents = activityTeamName
      ? Array.from(runningReadAgents.values())
        .filter(agent => agent.teamName === activityTeamName)
        .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const readAgents = runningAgents.filter(agent => (agent.role || "read") === "read");
    const writeAgents = runningAgents.filter(agent => (agent.role || "read") === "write");
    const activityConfig = activityTeamName ? await teams.readConfig(activityTeamName).catch(() => null) : null;
    const activityMembers = activityConfig?.members ?? [];
    const runtimeOnlyMembers = activityTeamName
      ? (await Promise.all(activityMembers
        .filter(member => member.name !== "team-lead")
        .filter(member => !runningReadAgents.has(readAgentKey(activityTeamName, member.name)))
        .map(async (member) => ({
          member,
          runtimeStatus: await runtime.readRuntimeStatus(activityTeamName, member.name).catch(() => null),
        }))))
        .filter((entry): entry is { member: Member; runtimeStatus: runtime.AgentRuntimeStatus } => isVisibleRuntimeOnlyMember(entry.member, entry.runtimeStatus))
      : [];
    const runtimeOnlyMemberNames = new Set(runtimeOnlyMembers.map(({ member }) => member.name));
    const runtimeOnlyReadMembers = runtimeOnlyMembers.filter(({ member }) => memberActivityRole(member) === "read");
    const runtimeOnlyWriteMembers = runtimeOnlyMembers.filter(({ member }) => memberActivityRole(member) === "write");
    const activeWriteMembers = activityTeamName
      ? activityMembers
        .filter(member => member.name !== "team-lead" && memberActivityRole(member) === "write")
        .filter(member => !!(member.tmuxPaneId && terminal?.isAlive?.(member.tmuxPaneId)) && !runningReadAgents.has(readAgentKey(activityTeamName, member.name)) && !runtimeOnlyMemberNames.has(member.name)) ?? []
      : [];
    const unreadLeadMessages = activityTeamName ? await messaging.readInbox(activityTeamName, agentName, true, false).catch(() => []) : [];
    leadInboxUnreadCount = unreadLeadMessages.length;
    clearLeadInboxWidgetOnce();

    if ((readAgents.length > 0 || writeAgents.length > 0 || runtimeOnlyReadMembers.length > 0 || runtimeOnlyWriteMembers.length > 0 || activeWriteMembers.length > 0) && !readAgentStatusTimer) {
      readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    }

    if (readAgents.length === 0 && writeAgents.length === 0 && runtimeOnlyReadMembers.length === 0 && runtimeOnlyWriteMembers.length === 0 && activeWriteMembers.length === 0) {
      sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
      clearTeamActivityWidget();
      sessionCtx.ui.setWidget?.("01-pi-extended-teams-status", undefined);
      if (readAgentStatusTimer) {
        clearInterval(readAgentStatusTimer);
        readAgentStatusTimer = null;
      }
      return;
    }

    const activeCount = readAgents.length + writeAgents.length + runtimeOnlyReadMembers.length + runtimeOnlyWriteMembers.length + activeWriteMembers.length;
    const entries: TeamActivityStatusEntry[] = [];
    const statusCounts: Record<string, number> = {};
    const idleNudgeMessages: string[] = [];
    const countStatus = (status: string | undefined) => {
      if (!status) return;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    };

    for (const agent of writeAgents) {
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
      const idleNudgeMessage = getIdleReadAgentNudgeMessage(agent, status);
      if (idleNudgeMessage) idleNudgeMessages.push(idleNudgeMessage);
      const modelLabel = formatModelLabel(agent.model, agent.thinking);
      const slotLabel = agent.modelSlot ? `slot:${agent.modelSlot}` : "";
      const detail = [modelLabel, slotLabel, elapsed, `${formatTokenCount(agent.tokensUsed)} tok`, status.detail].filter(Boolean).join(" · ");
      countStatus(status.label);
      entries.push({ name: agent.name, role: "write", status: status.label, detail });
    }

    for (const { member, runtimeStatus } of runtimeOnlyWriteMembers.sort((a, b) => a.member.name.localeCompare(b.member.name))) {
      const elapsed = formatElapsed(now - (runtimeStatus.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const slotLabel = member.modelSlot ? `slot:${member.modelSlot}` : "";
      const tokens = typeof runtimeStatus.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const screen = member.tmuxPaneId ? (member.windowId ? `${member.windowId}/${member.tmuxPaneId}` : member.tmuxPaneId) : "";
      const action = runtimeOnlyActionLabel(runtimeStatus);
      const heartbeat = runtimeOnlyHeartbeatDetail(runtimeStatus, now);
      const detail = [screen, modelLabel, slotLabel, elapsed, tokens, heartbeat, action].filter(Boolean).join(" · ");
      const status = runtimeOnlyStatusLabel(runtimeStatus, now);
      countStatus(status);
      entries.push({ name: member.name, role: "write", status, detail });
    }

    for (const member of activeWriteMembers.sort((a, b) => a.name.localeCompare(b.name))) {
      upsertWriterScreenTab(writerScreenState, {
        teamName: activityTeamName!,
        name: member.name,
        paneId: member.tmuxPaneId,
        windowId: member.windowId,
        joinedAt: member.joinedAt,
      });
      const runtimeStatus = await runtime.readRuntimeStatus(activityTeamName!, member.name).catch(() => null);
      const elapsed = formatElapsed(now - (runtimeStatus?.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const tokens = typeof runtimeStatus?.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const action = runtimeStatus?.activeToolName
        ? `${runtimeStatus.currentAction || "working"}: ${runtimeStatus.activeToolName}`
        : runtimeStatus?.currentAction || "running";
      const screen = member.windowId ? `${member.windowId}/${member.tmuxPaneId}` : member.tmuxPaneId;
      const detail = [screen, modelLabel, elapsed, tokens, action].filter(Boolean).join(" · ");
      countStatus("bg");
      entries.push({ name: member.name, role: "write", status: "bg", detail });
    }

    for (const { member, runtimeStatus } of runtimeOnlyReadMembers.sort((a, b) => a.member.name.localeCompare(b.member.name))) {
      const elapsed = formatElapsed(now - (runtimeStatus.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const slotLabel = member.modelSlot ? `slot:${member.modelSlot}` : "";
      const tokens = typeof runtimeStatus.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const action = runtimeOnlyActionLabel(runtimeStatus);
      const heartbeat = runtimeOnlyHeartbeatDetail(runtimeStatus, now);
      const detail = [modelLabel, slotLabel, elapsed, tokens, heartbeat, action].filter(Boolean).join(" · ");
      const status = runtimeOnlyStatusLabel(runtimeStatus, now);
      countStatus(status);
      entries.push({ name: member.name, role: "read", status, detail });
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
      const idleNudgeMessage = getIdleReadAgentNudgeMessage(agent, status);
      if (idleNudgeMessage) idleNudgeMessages.push(idleNudgeMessage);
      const modelLabel = formatModelLabel(agent.model, agent.thinking);
      const slotLabel = agent.modelSlot ? `slot:${agent.modelSlot}` : "";
      const detail = [modelLabel, slotLabel, elapsed, `${formatTokenCount(agent.tokensUsed)} tok`, status.detail].filter(Boolean).join(" · ");
      countStatus(status.label);
      entries.push({ name: agent.name, role: "read", status: status.label, detail });
    }

    wakeLeadForIdleReadAgents(idleNudgeMessages);

    sessionCtx.ui.setWidget?.("01-pi-extended-teams-status", undefined);
    updateTeamActivityWidget({
      activeCount,
      readCount: readAgents.length + runtimeOnlyReadMembers.length,
      writeCount: writeAgents.length + runtimeOnlyWriteMembers.length + activeWriteMembers.length,
      unreadCount: leadInboxUnreadCount,
      entries,
      statusCounts,
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
          const level = requireFavoriteModelLevel(loadSettings({ projectDir: queued.cwd }), queued.modelSlot);
          if (level.role !== "read") throw new Error(`Read helper ${queued.name} requires a reading-* level, got ${level.slot}.`);
          const [provider, modelId] = level.model.split("/", 2);
          const model = provider && modelId ? sessionCtx.modelRegistry?.find?.(provider, modelId) : undefined;
          if (!model) throw new Error(`Read helper model \"${level.model}\" from level ${level.slot} is not available in the lead session.`);

          const helperPrompt = buildReadHelperPrompt(queued.teamName, queued.requester, queued.prompt);
          const member: Member = {
            agentId: `${queued.name}@${queued.teamName}`,
            name: queued.name,
            agentType: "teammate",
            role: "read",
            model: level.model,
            joinedAt: Date.now(),
            tmuxPaneId: "",
            cwd: queued.cwd,
            subscriptions: [],
            prompt: helperPrompt,
            color: "cyan",
            thinking: level.thinking,
            modelSlot: level.slot,
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
      if (payload?.model || payload?.thinking || payload?.role) {
        throw new Error("Prompt-build agents must use model_slot only; direct model, thinking, or role is not allowed.");
      }
      const slot = payload?.model_slot || "reading-default";
      const level = requireFavoriteModelLevel(loadSettings({ projectDir: cwd }), slot);
      if (level.role !== "read") throw new Error(`Prompt-build requires a reading-* level, got ${level.slot}.`);

      if (!teams.teamExists(requestedTeamName)) {
        teams.createTeam(requestedTeamName, getPiSessionId(sessionCtx) || "local-session", "lead-agent", payload?.description || "pi-prompt prompt-build", level.model);
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
          model: level.model,
          joinedAt: Date.now(),
          tmuxPaneId: "",
          cwd,
          subscriptions: [],
          prompt,
          color: "cyan",
          thinking: level.thinking,
          modelSlot: level.slot,
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

  function setSessionCtx(ctx: any): void {
    sessionCtx = ctx;
    if (!isTeammate && !teamName) {
      const foundTeam = findLeadTeamForSession(getPiSessionId(ctx));
      if (foundTeam) adoptTeamAsLead(foundTeam, ctx);
    }
  }

  registerExtensionEvents(pi, {
    isTeammate,
    agentName,
    getTeamName: () => teamName,
    setSessionCtx,
    terminal,
    quietTrigger,
    startLeadInboxPolling,
    startLeadWatchdog,
    buildRoster,
    formatRosterForPrompt,
  });

  registerTeamCommand(pi, {
    getTeamName: ensureTeamPanelName,
    getLeadInboxUnreadCount: () => leadInboxUnreadCount,
    runningReadAgents,
    completedAgentReports,
    readAgentKey,
    terminal,
    shutdownTeammate,
  });
  registerFavoriteModelsCommand(pi);

  registerWriterScreenShortcut(pi, {
    getTeamName: () => teamName,
    terminal,
    state: writerScreenState,
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
    setSessionCtx,
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
    isTeammate,
    terminal,
    runningReadAgents,
    readAgentKey,
    shutdownTeammate,
    releaseAllClaimsForAgent,
    getTeamName: () => teamName,
  });

}
