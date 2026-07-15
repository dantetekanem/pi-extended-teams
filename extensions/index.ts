import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findLeadTeamForSession, getPiSessionId, registerLeadSession, resolveSkillFile } from "./internal/session-files.js";
import { buildReadAgentIdleNudgeMessage, describeReadAgentStatus, shouldNudgeReadAgentIdle, type ReadAgentStatusDescription } from "./ui/read-agent-status.js";
import { teamActivityStatusWidget, type TeamActivityStatusEntry, type TeamActivityStatusSnapshot } from "./ui/status-widget.js";
import { runReadAgentInProcess, sendMessageToRunningReadAgent } from "./agents/read-agent.js";
import { createWriteAgentRuntime } from "./agents/write-agent.js";
import { registerExtensionEvents } from "./events/register-events.js";
import { createLifecycleRuntime } from "./team/lifecycle.js";
import { buildRoster as buildTeamRoster, formatRosterForPrompt, releaseAllClaimsForAgent, requireTeamContext as resolveTeamContext, requireWriteAgentTeam as resolveWriteAgentTeam } from "./team/roster.js";
import { createWriterScreenState, registerWriterScreenShortcut, removeWriterScreenTab, upsertWriterScreenTab, type ActiveWriterTab } from "./team/writer-screens.js";
import { registerFavoriteModelsCommand } from "./ui/favorite-models-command.js";
import { registerExtensionsCommand } from "./ui/extensions-command.js";
import { installAgentNavigation } from "./ui/agent-navigation.js";
import { buildReadHelperPrompt, registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerTaskRuntimeTools } from "./tools/task-runtime-tools.js";
import { registerTeamTools } from "./tools/team-tools.js";
import { canonicalPersistedModelSlot, loadSettings, requireFavoriteModelLevel } from "../src/utils/settings";
import { formatAnimatedProgress, formatElapsed, formatModelLabel, formatTokenCount } from "./ui/renderers.js";
import type { CompletedAgentReport, RunningReadAgent } from "./runtime/types.js";
export { panelBgFill, framePanel, frameWidget, frameWidgetFullWidth, logWindowStart } from "./ui/frame.js";
import * as messaging from "../src/utils/messaging";
import * as teams from "../src/utils/teams";
import * as runtime from "../src/utils/runtime";
import * as teamPaths from "../src/utils/paths";
import { listReadHelperQueue, removeQueuedReadHelperRequest } from "../src/utils/read-helper-queue";
import type { Member } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import { createSpawnResourcePlan, parentProjectTrustForSpawn } from "./resources/spawn-resource-plan.js";
import { generateExtensionInstanceId, listLifecycleTombstones, onLifecycleTombstoneCleared, readLifecycleTombstone } from "../src/utils/lifecycle-tombstone";

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  const extensionInstanceId = generateExtensionInstanceId();
  const envTeamName = process.env.PI_TEAM_NAME;

  // Teammates are explicitly bound by PI_TEAM_NAME. Lead sessions are adopted
  // later at session_start only when the persisted Pi session id matches.
  let teamName = envTeamName;

  const terminal = getTerminalAdapter();
  const activeWritersTabs: ActiveWriterTab[] = [];
  const writerScreenState = createWriterScreenState(activeWritersTabs);

  // Track whether lead inbox/helper polling has been started (to avoid duplicates)
  let leadPollingStarted = false;
  let leadInboxPollTimer: NodeJS.Timeout | null = null;
  let readHelperQueueWatchedTeam: string | null = null;
  let readHelperQueueWatcher: fs.FSWatcher | null = null;
  let readHelperQueueFallbackStarted = false;
  let readHelperQueueFallbackTimer: NodeJS.Timeout | null = null;
  let readHelperQueueDraining = false;
  let readHelperQueueDrainPending = false;
  let sessionCtx: any = null;
  let extensionShuttingDown = false;
  const lifecycleFenceClearUnsubscribe = onLifecycleTombstoneCleared((clearedTeamName) => {
    if (clearedTeamName === teamName) void drainReadHelperQueueOnce();
  });
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
  // Message identities already injected into the lead prompt. Tracking identity
  // instead of unread count prevents a read message being replaced by a new one
  // at the same count from silently suppressing the new wake.
  const leadWakeNotifiedMessageKeys = new Set<string>();
  const createCurrentSpawnResourcePlan = (input: { cwd: string; projectTrusted: boolean }) => {
    return createSpawnResourcePlan({ ...input, pi });
  };
  const { startWriteAgent, drainWriteQueue } = createWriteAgentRuntime({
    terminal,
    getProjectTrusted: (cwd) => parentProjectTrustForSpawn(sessionCtx, cwd),
    createResourcePlan: createCurrentSpawnResourcePlan,
    onWriterActive: (tab) => upsertWriterScreenTab(writerScreenState, tab),
    onWriterInactive: (targetTeamName, member) => removeWriterScreenTab(writerScreenState, { teamName: targetTeamName, name: member.name, paneId: member.tmuxPaneId }),
  });
  const { shutdownTeammate, startLeadWatchdog, stopLeadWatchdog } = createLifecycleRuntime({
    isTeammate,
    terminal,
    runningReadAgents,
    readAgentKey,
    isCurrentReadAgentRun,
    renderReadAgentStatus,
    drainWriteQueue,
    getSessionCwd: () => sessionCtx?.cwd,
    getTeamName: () => teamName,
    extensionInstanceId,
    onWriterInactive: (targetTeamName, member) => removeWriterScreenTab(writerScreenState, { teamName: targetTeamName, name: member.name, paneId: member.tmuxPaneId }),
  });

  function readAgentKey(targetTeamName: string, targetAgentName: string): string {
    return `${targetTeamName}:${targetAgentName}`;
  }

  function observeReadAgentLaunch(launch: Promise<void> | void): void {
    // The runner reports its own terminal failures and owns teardown. This
    // observer exists only to terminate the fire-and-forget rejection chain.
    void Promise.resolve(launch).catch(() => {});
  }

  async function deliverMessageToActiveAgent(targetTeamName: string, targetAgentName: string, content: string): Promise<boolean> {
    const delivered = await sendMessageToRunningReadAgent(
      runningReadAgents.get(readAgentKey(targetTeamName, targetAgentName)),
      content
    );
    if (delivered) renderReadAgentStatus();
    return delivered;
  }

  function memberActivityRole(member: Member): "read" | "write" {
    if (member.role === "read" || member.role === "write") return member.role;
    return member.modelSlot?.startsWith("reading-") ? "read" : "write";
  }

  function runtimeHeartbeatIsRecent(status: runtime.AgentRuntimeStatus, now: number): boolean {
    return !!status.lastHeartbeatAt && (now - status.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;
  }

  function hasActiveReadAgentLifecycle(agent: RunningReadAgent): boolean {
    return agent.teardownState !== "stopping"
      && agent.teardownState !== "quarantined"
      && agent.teardownState !== "persistence_failed"
      && agent.teardownState !== "finalized";
  }

  function isVisibleRuntimeOnlyMember(
    member: Member,
    runtimeStatus: runtime.AgentRuntimeStatus | null,
    now: number
  ): runtimeStatus is runtime.AgentRuntimeStatus {
    return member.isActive !== false
      && runtimeStatus?.ready === true
      && runtimeHeartbeatIsRecent(runtimeStatus, now);
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

  function formatAgentProgressStatus(
    name: string,
    model: string | undefined,
    thinking: string | undefined,
    modelSlot: string | undefined,
    elapsed: string,
    tokens: string,
    latestProgress: string | undefined,
    now: number
  ): string {
    const shortModel = model ? model.split("/").pop() || model : "";
    const modelAndThinking = [shortModel, thinking].filter(Boolean).join("/");
    const identity = modelAndThinking ? `(${name}) ${modelAndThinking}` : `(${name})`;
    const progress = latestProgress ? `progress: ${formatAnimatedProgress(latestProgress, now)}` : undefined;
    return [identity, modelSlot, elapsed, `${tokens} tok`, progress].filter(Boolean).join(" · ");
  }

  function currentSessionAgentGroupName(ctx?: any): string | undefined {
    const sessionId = getPiSessionId(ctx ?? sessionCtx) || "local-session";
    return teamPaths.sanitizeName(`session-${sessionId}`);
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
  function emitAgentReport(reportTeamName: string, name: string, startedAt: number, tokens: number, report: string, ok: boolean, suppressLeadInjection = false): void {
    const api = pi as any;
    const details = { name, elapsedMs: Date.now() - startedAt, tokens, ok };
    pi.events?.emit?.("pi-extended-teams:agent-report", { teamName: reportTeamName, name, startedAt, tokens, report, ok, details });

    // pi-prompt prompt-build teams are extension-controlled fanout jobs. Their
    // reports are consumed by pi-prompt via the event above and must not be
    // injected as visible user turns, otherwise the main agent starts answering
    // each branch report and can ask unrelated follow-up questions.
    if (suppressLeadInjection || reportTeamName.startsWith("prompt-build-")) return;

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
    const keyedUnread = unread.map((message) => ({
      message,
      key: String(message?.id || `${message?.from || "unknown"}:${message?.timestamp || ""}:${message?.text || ""}`),
    }));
    const currentKeys = new Set(keyedUnread.map(({ key }) => key));
    for (const key of leadWakeNotifiedMessageKeys) {
      if (!currentKeys.has(key)) leadWakeNotifiedMessageKeys.delete(key);
    }
    const fresh = keyedUnread.filter(({ key }) => {
      if (leadWakeNotifiedMessageKeys.has(key)) return false;
      leadWakeNotifiedMessageKeys.add(key);
      return true;
    });
    if (fresh.length === 0) return;

    // Always enqueue a real lead prompt, including while the current turn is busy.
    // `quietTrigger` uses a follow-up user turn so Pi delivers it after the current
    // turn instead of relying on another poll or the user typing manually.
    const label = fresh.length === 1 ? "1 new agent message" : `${fresh.length} new agent messages`;
    const hasFinalReport = fresh.some(({ message }) => message?.metadata?.finalReport === true);
    const opening = hasFinalReport
      ? `A teammate finished and sent its final report: ${label} is ready in the ${teamName} inbox.`
      : `Check your agent messages now: ${label} is ready in the ${teamName} inbox.`;
    quietTrigger(
      `${opening} Call read_inbox once, integrate the new information, and continue the active task. The reporting agent is self-exiting; do not call stop_teammate after a final report. This is an automatic user-style follow-up; do not sleep or poll.`
    );
  }

  async function notifyLeadOfInboxReports(targetTeamName: string): Promise<void> {
    if (isTeammate) return;
    const unread = await messaging.peekInbox(targetTeamName, agentName, true);
    await renderLeadInboxStatus();
    wakeLeadForInboxReports(unread);
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
    if (extensionShuttingDown || teamActivityRenderTimer || teamActivityRenderInFlight) return;
    teamActivityRenderTimer = setTimeout(() => {
      teamActivityRenderTimer = null;
      void flushTeamActivityStatusRender();
    }, Math.max(0, delayMs));
  }

  function markTeamActivityStatusDirty(delayMs = TEAM_ACTIVITY_RENDER_DEBOUNCE_MS): void {
    if (extensionShuttingDown) return;
    teamActivityRenderDirty = true;
    queueTeamActivityStatusRender(delayMs);
  }

  async function renderTeamActivityStatus(): Promise<void> {
    if (extensionShuttingDown) return;
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
        return teamActivityStatusWidget(
          () => teamActivityStatusSnapshot,
          isTeamActivityExpanded,
          () => tui.requestRender?.()
        );
      },
      { placement: "belowEditor" }
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
        .filter(agent => agent.teamName === activityTeamName && hasActiveReadAgentLifecycle(agent))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const readAgents = runningAgents.filter(agent => (agent.role || "read") === "read");
    const writeAgents = runningAgents.filter(agent => (agent.role || "read") === "write");
    const activityConfig = activityTeamName ? await teams.readConfig(activityTeamName).catch(() => null) : null;
    const activityMembers = activityConfig?.members ?? [];
    const activityTombstones = activityTeamName
      ? await listLifecycleTombstones(activityTeamName).catch(() => [])
      : [];
    const runtimeOnlyMembers = activityTeamName
      ? (await Promise.all(activityMembers
        .filter(member => member.name !== "team-lead")
        .filter(member => !runningReadAgents.has(readAgentKey(activityTeamName, member.name)))
        .map(async (member) => ({
          member,
          runtimeStatus: await runtime.readRuntimeStatus(activityTeamName, member.name).catch(() => null),
        }))))
        .filter((entry): entry is { member: Member; runtimeStatus: runtime.AgentRuntimeStatus } => isVisibleRuntimeOnlyMember(entry.member, entry.runtimeStatus, now))
      : [];
    const runtimeOnlyMemberNames = new Set(runtimeOnlyMembers.map(({ member }) => member.name));
    const runtimeOnlyReadMembers = runtimeOnlyMembers.filter(({ member }) => memberActivityRole(member) === "read");
    const runtimeOnlyWriteMembers = runtimeOnlyMembers.filter(({ member }) => memberActivityRole(member) === "write");
    const activeWriteMembers = activityTeamName
      ? activityMembers
        .filter(member => member.name !== "team-lead" && member.isActive !== false && memberActivityRole(member) === "write")
        .filter(member => !!(member.tmuxPaneId && terminal?.isAlive?.(member.tmuxPaneId)) && !runningReadAgents.has(readAgentKey(activityTeamName, member.name)) && !runtimeOnlyMemberNames.has(member.name)) ?? []
      : [];
    const unreadLeadMessages = activityTeamName ? await messaging.readInbox(activityTeamName, agentName, true, false).catch(() => []) : [];
    leadInboxUnreadCount = unreadLeadMessages.length;
    clearLeadInboxWidgetOnce();

    if ((readAgents.length > 0 || writeAgents.length > 0 || runtimeOnlyReadMembers.length > 0 || runtimeOnlyWriteMembers.length > 0 || activeWriteMembers.length > 0 || activityTombstones.length > 0) && !readAgentStatusTimer) {
      readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    }

    if (readAgents.length === 0 && writeAgents.length === 0 && runtimeOnlyReadMembers.length === 0 && runtimeOnlyWriteMembers.length === 0 && activeWriteMembers.length === 0 && activityTombstones.length === 0) {
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
    const footerStatuses: string[] = [];
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
      const tokenCount = formatTokenCount(agent.tokensUsed);
      const detail = [modelLabel, slotLabel, elapsed, `${tokenCount} tok`, status.detail].filter(Boolean).join(" · ");
      countStatus(status.label);
      entries.push({ name: agent.name, role: "write", status: status.label, detail });
      footerStatuses.push(formatAgentProgressStatus(agent.name, agent.model, agent.thinking, agent.modelSlot, elapsed, tokenCount, agent.latestProgress, now));
    }

    for (const { member, runtimeStatus } of runtimeOnlyWriteMembers.sort((a, b) => a.member.name.localeCompare(b.member.name))) {
      const elapsed = formatElapsed(now - (runtimeStatus.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
      const slotLabel = modelSlot ? `slot:${modelSlot}` : "";
      const tokens = typeof runtimeStatus.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const screen = member.tmuxPaneId ? (member.windowId ? `${member.windowId}/${member.tmuxPaneId}` : member.tmuxPaneId) : "";
      const action = runtimeOnlyActionLabel(runtimeStatus);
      const heartbeat = runtimeOnlyHeartbeatDetail(runtimeStatus, now);
      const detail = [screen, modelLabel, slotLabel, elapsed, tokens, heartbeat, action].filter(Boolean).join(" · ");
      const status = runtimeOnlyStatusLabel(runtimeStatus, now);
      countStatus(status);
      entries.push({ name: member.name, role: "write", status, detail });
      footerStatuses.push(formatAgentProgressStatus(member.name, member.model, member.thinking, modelSlot, elapsed, tokens.replace(/ tok$/, ""), runtimeStatus.latestProgress, now));
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
      const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
      countStatus("bg");
      entries.push({ name: member.name, role: "write", status: "bg", detail });
      footerStatuses.push(formatAgentProgressStatus(member.name, member.model, member.thinking, modelSlot, elapsed, tokens.replace(/ tok$/, ""), runtimeStatus?.latestProgress, now));
    }

    for (const { member, runtimeStatus } of runtimeOnlyReadMembers.sort((a, b) => a.member.name.localeCompare(b.member.name))) {
      const elapsed = formatElapsed(now - (runtimeStatus.startedAt || member.joinedAt));
      const modelLabel = formatModelLabel(member.model, member.thinking);
      const modelSlot = canonicalPersistedModelSlot(member.modelSlot);
      const slotLabel = modelSlot ? `slot:${modelSlot}` : "";
      const tokens = typeof runtimeStatus.tokensUsed === "number" ? `${formatTokenCount(runtimeStatus.tokensUsed)} tok` : "0 tok";
      const action = runtimeOnlyActionLabel(runtimeStatus);
      const heartbeat = runtimeOnlyHeartbeatDetail(runtimeStatus, now);
      const detail = [modelLabel, slotLabel, elapsed, tokens, heartbeat, action].filter(Boolean).join(" · ");
      const status = runtimeOnlyStatusLabel(runtimeStatus, now);
      countStatus(status);
      entries.push({ name: member.name, role: "read", status, detail });
      footerStatuses.push(formatAgentProgressStatus(member.name, member.model, member.thinking, modelSlot, elapsed, tokens.replace(/ tok$/, ""), runtimeStatus.latestProgress, now));
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
      const tokenCount = formatTokenCount(agent.tokensUsed);
      const detail = [modelLabel, slotLabel, elapsed, `${tokenCount} tok`, status.detail].filter(Boolean).join(" · ");
      countStatus(status.label);
      entries.push({ name: agent.name, role: "read", status: status.label, detail });
      footerStatuses.push(formatAgentProgressStatus(agent.name, agent.model, agent.thinking, agent.modelSlot, elapsed, tokenCount, agent.latestProgress, now));
    }

    for (const { agentName: quarantinedName, result } of activityTombstones) {
      const persistedMember = activityMembers.find(member => member.name === quarantinedName);
      const role = result.status === "occupied"
        ? result.tombstone.role
        : persistedMember ? memberActivityRole(persistedMember) : "read";
      const detail = result.status === "occupied"
        ? `inactive · run ${result.tombstone.runId} · ${result.tombstone.phase}`
        : `inactive · corrupt lifecycle tombstone · ${result.error}`;
      countStatus("quarantined");
      entries.push({ name: quarantinedName, role, status: "quarantined", detail });
    }

    wakeLeadForIdleReadAgents(idleNudgeMessages);

    for (const [index, entry] of entries.entries()) entry.displayText = footerStatuses[index];

    sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
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
        const [nextQueued] = await listReadHelperQueue(teamName);
        if (!nextQueued) break;
        const fence = await readLifecycleTombstone(teamName, nextQueued.name);
        if (fence.status !== "absent") break;
        const queued = nextQueued;

        try {
          const config = await teams.readConfig(queued.teamName);
          if (config.members.some(member => member.name === queued.name)) {
            throw new Error(`Teammate ${queued.name} already exists in team ${queued.teamName}.`);
          }
          const level = requireFavoriteModelLevel(loadSettings({ projectDir: queued.cwd }), queued.modelSlot);
          if (level.role !== "read") throw new Error(`Read helper ${queued.name} requires a read-* intent tier configured via /agents-favorite-models, got ${level.slot}.`);
          const [provider, modelId] = level.model.split("/", 2);
          const model = provider && modelId ? sessionCtx.modelRegistry?.find?.(provider, modelId) : undefined;
          if (!model) throw new Error(`Read helper model \"${level.model}\" from intent tier ${level.slot} is not available in the lead session.`);

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
          observeReadAgentLaunch(
            runReadAgentInProcess(queued.teamName, member, helperPrompt, sessionCtx, readAgentOptions())
          );
          await removeQueuedReadHelperRequest(teamName, queued.id);
        } catch (e) {
          const latestFence = await readLifecycleTombstone(queued.teamName, queued.name);
          if (latestFence.status !== "absent") {
            await messaging.sendPlainMessage(
              queued.teamName,
              "system",
              "team-lead",
              `Retained read helper ${queued.name}: lifecycle quarantine appeared before admission.`,
              `Read helper ${queued.name} retained by quarantine`,
              "yellow"
            ).catch(() => {});
            break;
          }
          await removeQueuedReadHelperRequest(teamName, queued.id);
          const message = `Read helper ${queued.name} could not start for ${queued.requester}: ${e instanceof Error ? e.message : String(e)}`;
          let requesterReceivedFailure = queued.requester === "team-lead";
          if (!requesterReceivedFailure) {
            try {
              const deliveredDirectly = await deliverMessageToActiveAgent(queued.teamName, queued.requester, message);
              if (!deliveredDirectly) {
                await messaging.sendPlainMessageIfRunning(
                  queued.teamName,
                  queued.name,
                  queued.requester,
                  message,
                  `Read helper ${queued.name} failed`,
                  "red"
                );
              }
              requesterReceivedFailure = true;
            } catch {
              requesterReceivedFailure = false;
            }
          }
          const delivery = requesterReceivedFailure
            ? `Failure sent to ${queued.requester}.`
            : `${queued.requester} is no longer running; the failure is retained here.`;
          await messaging.sendPlainMessage(
            queued.teamName,
            queued.name,
            "team-lead",
            `${message} ${delivery}`,
            `Read helper ${queued.name} failed`,
            "red",
            { metadata: { finalReport: true, helperCompletion: true, outcome: "failed", requestedBy: queued.requester } }
          ).catch(() => {});
          await notifyLeadOfInboxReports(queued.teamName).catch(() => {});
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
      readHelperQueueFallbackTimer = setInterval(() => { void drainReadHelperQueueOnce(); }, 5000);
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

    leadInboxPollTimer = setInterval(async () => {
      if (!teamName) return;
      try {
        const unread = await messaging.readInbox(teamName, agentName, true, false);
        await renderLeadInboxStatus();
        wakeLeadForInboxReports(unread);
      } catch {
        // Ignore errors for lead polling
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
      const slot = payload?.model_slot || "read-review";
      const level = requireFavoriteModelLevel(loadSettings({ projectDir: cwd }), slot);
      if (level.role !== "read") throw new Error(`Prompt-build requires a read-* intent tier configured via /agents-favorite-models, got ${level.slot}.`);

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
        observeReadAgentLaunch(
          runReadAgentInProcess(requestedTeamName, member, prompt, sessionCtx, readAgentOptions())
        );
        pi.events?.emit?.("pi-prompt:prompt-build:progress", { teamName: requestedTeamName, status: "spawned", started: i + 1, total: prompts.length, text: `building prompt — ${i + 1}/${prompts.length} branches started` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pi.events?.emit?.("pi-prompt:prompt-build:error", { teamName: requestedTeamName, error: message });
    }
  });

  function setSessionCtx(ctx: any): void {
    extensionShuttingDown = false;
    sessionCtx = ctx;
    if (!isTeammate && !teamName) {
      const foundTeam = findLeadTeamForSession(getPiSessionId(ctx));
      if (foundTeam) adoptTeamAsLead(foundTeam, ctx);
    }
  }

  async function stopRunningAgentsForShutdown(reason: unknown): Promise<void> {
    const states = Array.from(runningReadAgents.values());
    const results = await Promise.all(states.map(async (state) => {
      const config = await teams.readConfig(state.teamName).catch(() => null);
      const member = config?.members.find(item => item.name === state.name) ?? {
        agentId: `${state.name}@${state.teamName}`,
        name: state.name,
        agentType: "teammate" as const,
        role: state.role === "write" ? "write" as const : "read" as const,
        model: state.model,
        thinking: state.thinking as Member["thinking"],
        modelSlot: state.modelSlot as Member["modelSlot"],
        joinedAt: state.startedAt,
        tmuxPaneId: "",
        cwd: "",
        subscriptions: [],
        lifecycleRunId: state.runId,
      };
      return shutdownTeammate(state.teamName, member, { drainQueue: false, reason });
    }));

    const failures = results.filter(result => result.status === "persistence_failed" || result.status === "cleanup_failed");
    if (failures.length > 0) {
      throw new Error(`Could not close ${failures.length} agent recipient(s) during extension shutdown: ${failures.map(result => result.error || result.status).join("; ")}`);
    }
  }

  async function cleanupExtensionRuntime(ctx: any, reason: unknown): Promise<void> {
    extensionShuttingDown = true;
    sessionCtx = null;
    stopLeadWatchdog();
    if (readAgentStatusTimer) clearInterval(readAgentStatusTimer);
    if (teamActivityRenderTimer) clearTimeout(teamActivityRenderTimer);
    if (leadInboxPollTimer) clearInterval(leadInboxPollTimer);
    if (readHelperQueueFallbackTimer) clearInterval(readHelperQueueFallbackTimer);
    readHelperQueueWatcher?.close();

    readAgentStatusTimer = null;
    teamActivityRenderTimer = null;
    leadInboxPollTimer = null;
    readHelperQueueFallbackTimer = null;
    readHelperQueueWatcher = null;
    leadPollingStarted = false;
    leadWakeNotifiedMessageKeys.clear();
    readHelperQueueFallbackStarted = false;
    readHelperQueueWatchedTeam = null;
    lifecycleFenceClearUnsubscribe();
    teamActivityRenderDirty = false;
    settleTeamActivityRenderWaiters();

    await stopRunningAgentsForShutdown(reason);

    teamActivityStatusSnapshot = null;
    teamActivityStatusSnapshotSignature = null;
    teamActivityWidgetMounted = false;
    teamActivityWidgetTui = null;
    ctx?.ui?.setWidget?.("01-pi-extended-teams-readers", undefined);
    ctx?.ui?.setWidget?.("01-pi-extended-teams-status", undefined);
    ctx?.ui?.setStatus?.("01-pi-extended-teams-read", undefined);
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

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    await cleanupExtensionRuntime(ctx, event?.reason);
  });

  if (!isTeammate) {
    pi.on("session_start", async (_event: any, ctx: any) => {
      installAgentNavigation(ctx, {
        getAgents: () => Array.from(runningReadAgents.values())
          .filter(agent => !teamName || agent.teamName === teamName),
        stopAgent: async (name: string) => {
          const targetTeamName = teamName;
          if (!targetTeamName) return;
          const config = await teams.readConfig(targetTeamName);
          const member = config.members.find(item => item.name === name && item.name !== "team-lead");
          if (!member) return;
          const teardown = await shutdownTeammate(targetTeamName, member);
          if (teardown.status === "settled" && teardown.finalized && teardown.removedMember) {
            ctx.ui?.notify?.(`Stopped agent ${name}.`, "info");
          } else if (teardown.status === "timed_out") {
            ctx.ui?.notify?.(`Agent ${name} is inactive but quarantined after teardown timed out.`, "warning");
          } else {
            ctx.ui?.notify?.(`Agent ${name} cleanup is blocked${teardown.error ? `: ${teardown.error}` : "."}`, "warning");
          }
        },
        sendMessage: async (name: string, content: string) => {
          const targetTeamName = teamName;
          if (!targetTeamName) throw new Error("No active agent session context is available.");
          const deliveredDirectly = await deliverMessageToActiveAgent(targetTeamName, name, content);
          if (!deliveredDirectly) {
            await messaging.sendPlainMessageIfRunning(targetTeamName, "team-lead", name, content, "Message from team-lead");
          }
        },
      });
    });
  }

  registerFavoriteModelsCommand(pi);
  registerExtensionsCommand(pi);

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
      shutdownTeammate,
      agentName,
      renderLeadInboxStatus,
      notifyLeadOfInboxReports,
      deliverMessageToActiveAgent,
      createResourcePlan: createCurrentSpawnResourcePlan,
      extensionInstanceId,
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
    resetLeadWakeNotifiedCount: () => { leadWakeNotifiedMessageKeys.clear(); },
    deliverMessageToActiveAgent,
    extensionInstanceId,
  });

  registerTaskRuntimeTools(pi, {
    isTeammate,
    terminal,
    runningReadAgents,
    readAgentKey,
    shutdownTeammate,
    getTeamName: () => teamName,
  });

}
