import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as claims from "../../src/utils/claims";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import { dimAnsi, pink, purple } from "./ansi";
import { framePanel, logWindowStart } from "./frame";
import { isDownInput, isLeftInput, isRightInput, isUpInput } from "./input";
import { formatElapsed, formatTokenCount, formatTranscriptLines, sanitizeTuiLine } from "./renderers";
import type { CompletedAgentReport, RunningReadAgent } from "../runtime/types";
import type { Member } from "../../src/utils/models";

export interface TeamPanelOptions {
  getTeamName(ctx?: any): string | null | undefined | Promise<string | null | undefined>;
  getLeadInboxUnreadCount(): number;
  runningReadAgents: Map<string, RunningReadAgent>;
  completedAgentReports: Map<string, CompletedAgentReport[]>;
  readAgentKey(teamName: string, agentName: string): string;
  terminal: any;
  shutdownTeammate(teamName: string, member: Member): Promise<void>;
}

export interface TeamPanelItem {
  name: string;
  role: string;
  status: string;
  model?: string;
  thinking?: string;
  unreadCount: number;
  elapsedMs: number;
  tokensUsed: number;
  taskSubjects: string[];
  claimPaths: string[];
  recentEvents: string[];
  runtimeStatus: any;
  tmuxPaneId?: string;
  windowId?: string;
  completed: boolean;
  completedAt?: number;
  summary?: string;
  reportText?: string;
  requestedBy?: string;
}

export const MAX_COMPLETED_REPORTS = 50;
const MAX_DETAIL_TEXT_CHARS = 8_000;
const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_TRANSCRIPT_LINES = 80;
const RECENT_EVENT_DISPLAY_LIMIT = 12;

function inferRequestedBy(summary: string, text: string): string | undefined {
  const source = `${summary}\n${text}`;
  const match = source.match(/(?:completed|failed) for ([A-Za-z0-9_-]+)/);
  return match?.[1];
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function buildTaskSubjectIndex(allTasks: any[]): Map<string, string[]> {
  const subjectsByOwner = new Map<string, string[]>();
  for (const task of allTasks) {
    if (!task?.owner || task.status === "completed" || task.status === "deleted") continue;
    appendMapValue(subjectsByOwner, task.owner, `#${task.id} ${task.subject}`);
  }
  return subjectsByOwner;
}

function buildClaimPathIndex(allClaims: Array<{ agent: string; path: string }>): Map<string, string[]> {
  const pathsByAgent = new Map<string, string[]>();
  for (const claim of allClaims) {
    if (!claim?.agent || !claim?.path) continue;
    appendMapValue(pathsByAgent, claim.agent, claim.path);
  }
  return pathsByAgent;
}

function hasFinalReportMetadata(metadata: any): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return typeof metadata.startedAt === "number"
    || typeof metadata.elapsedMs === "number"
    || typeof metadata.tokensUsed === "number"
    || typeof metadata.costUsd === "number"
    || typeof metadata.model === "string"
    || typeof metadata.thinking === "string";
}

function completionStatusFromLeadInboxMessage(message: any): CompletedAgentReport["status"] | null {
  const summary = String(message.summary || "").trim();
  if (/^Read agent .+ completed$/i.test(summary) || /^Read helper .+ done$/i.test(summary)) return "completed";
  if (/^Read agent .+ failed$/i.test(summary) || /^Read helper .+ failed$/i.test(summary)) return "failed";
  if (/^Final report$/i.test(summary) || hasFinalReportMetadata(message.metadata)) return "completed";
  return null;
}

function completedReportFromLeadInboxMessage(message: any): CompletedAgentReport | null {
  const from = String(message.from || "");
  if (!from || from === "team-lead" || from === "system" || from === "watchdog") return null;

  const status = completionStatusFromLeadInboxMessage(message);
  if (!status) return null;

  const summary = String(message.summary || "Final report");
  const text = String(message.text || "");
  const metadata = message.metadata || {};
  const role = summary.startsWith("Read helper ") || summary.startsWith("Read agent ") ? "read" : "write";
  return {
    name: String(message.from),
    role,
    status,
    report: text,
    summary,
    completedAt: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
    startedAt: typeof metadata.startedAt === "number" ? metadata.startedAt : undefined,
    elapsedMs: typeof metadata.elapsedMs === "number" ? metadata.elapsedMs : undefined,
    tokensUsed: typeof metadata.tokensUsed === "number" ? metadata.tokensUsed : undefined,
    costUsd: typeof metadata.costUsd === "number" ? metadata.costUsd : undefined,
    model: typeof metadata.model === "string" ? metadata.model : undefined,
    thinking: typeof metadata.thinking === "string" ? metadata.thinking : undefined,
    color: message.color,
    requestedBy: inferRequestedBy(summary, text),
    source: "lead-inbox" as const,
  };
}

function collectRecentLeadInboxReports(leadInboxMessages: any[]): CompletedAgentReport[] {
  const reports: CompletedAgentReport[] = [];
  for (let index = leadInboxMessages.length - 1; index >= 0 && reports.length < MAX_COMPLETED_REPORTS; index--) {
    const report = completedReportFromLeadInboxMessage(leadInboxMessages[index]);
    if (report && report.report.trim().length > 0) reports.push(report);
  }
  return reports;
}

function mergeRecentCompletedReports(reports: CompletedAgentReport[]): CompletedAgentReport[] {
  const seenCompleted = new Set<string>();
  const merged: CompletedAgentReport[] = [];
  const sorted = reports
    .filter((report) => report.report.trim().length > 0)
    .sort((a, b) => b.completedAt - a.completedAt);

  for (const report of sorted) {
    const dedupeKey = `${report.name}:${report.completedAt}:${report.summary || ""}`;
    if (seenCompleted.has(dedupeKey)) continue;
    seenCompleted.add(dedupeKey);
    merged.push(report);
    if (merged.length >= MAX_COMPLETED_REPORTS) break;
  }
  return merged;
}

function previewLongText(text: string, maxChars = MAX_DETAIL_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}\n${dimAnsi(`… truncated ${omitted} characters for /team rendering`)}`;
}

export async function buildTeamPanelItems(panelTeamName: string, options: TeamPanelOptions): Promise<TeamPanelItem[]> {
  const [config, allTasks, allClaims] = await Promise.all([
    teams.readConfig(panelTeamName),
    tasks.listTasks(panelTeamName).catch(() => []),
    claims.listClaims(panelTeamName).catch(() => []),
  ]);
  const taskSubjectsByOwner = buildTaskSubjectIndex(allTasks);
  const claimPathsByAgent = buildClaimPathIndex(allClaims);
  const now = Date.now();
  const members = config.members.filter((m) => m.name !== "team-lead");

  const activeItems = await Promise.all(members.map(async (member): Promise<TeamPanelItem> => {
    const readState = options.runningReadAgents.get(options.readAgentKey(panelTeamName, member.name));
    const [runtimeStatus, inboxMessages] = await Promise.all([
      runtime.readRuntimeStatus(panelTeamName, member.name).catch(() => null),
      messaging.readInbox(panelTeamName, member.name, true, false).catch(() => []),
    ]);
    const role = member.role || "write";
    const alive = !!readState || !!runtimeStatus?.ready || (role === "write" && !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId)));
    const status = readState?.status || runtimeStatus?.currentAction || (alive ? "running" : "idle/dead");
    const startedAt = readState?.startedAt || runtimeStatus?.startedAt || member.joinedAt;
    const tokensUsed = readState?.tokensUsed ?? runtimeStatus?.tokensUsed ?? 0;

    return {
      name: member.name,
      role,
      status,
      model: member.model,
      thinking: member.thinking,
      unreadCount: inboxMessages.length,
      elapsedMs: now - startedAt,
      tokensUsed,
      taskSubjects: taskSubjectsByOwner.get(member.name) ?? [],
      claimPaths: claimPathsByAgent.get(member.name) ?? [],
      recentEvents: readState?.recentEvents || [],
      runtimeStatus,
      tmuxPaneId: member.tmuxPaneId,
      windowId: member.windowId,
      completed: false,
      requestedBy: member.requestedBy,
    };
  }));

  const leadInboxMessages = await messaging.readInbox(panelTeamName, "team-lead", false, false).catch(() => []);
  const completedReports = mergeRecentCompletedReports([
    ...(options.completedAgentReports.get(panelTeamName) ?? []),
    ...collectRecentLeadInboxReports(leadInboxMessages),
  ]);
  const completedItems: TeamPanelItem[] = completedReports.map((report) => ({
    name: report.name,
    role: report.role,
    status: report.status,
    model: report.model,
    thinking: report.thinking,
    unreadCount: 0,
    elapsedMs: report.elapsedMs ?? (report.startedAt ? report.completedAt - report.startedAt : 0),
    tokensUsed: report.tokensUsed || 0,
    taskSubjects: [],
    claimPaths: [],
    recentEvents: [],
    runtimeStatus: null,
    completed: true,
    completedAt: report.completedAt,
    summary: report.summary,
    reportText: report.report,
    requestedBy: report.requestedBy,
  }));

  return [...activeItems, ...completedItems].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) return (b.completedAt || 0) - (a.completedAt || 0);
    return a.name.localeCompare(b.name);
  });
}

export function registerTeamCommand(pi: any, options: TeamPanelOptions): void {
  const command = {
    description: "Inspect main + agents (↑/↓), refresh (r), focus log (←/→), or stop selected agent (x).",
    handler: async (args: string, ctx: any) => {
      const panelTeamName = args.trim() || await options.getTeamName(ctx);
      if (!panelTeamName) {
        ctx.ui.notify("No active agent session. Spawn an agent first.", "warning");
        return;
      }

      let items = await buildTeamPanelItems(panelTeamName, options);
      let selectedIndex = 0;
      let loading = false;
      let focusedPane: "list" | "log" = "list";
      let logOffsetFromBottom = 0;

      await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
        const entryCount = () => items.length + 1;
        let autoRefreshInFlight = false;
        let liveTimer: ReturnType<typeof setInterval> | undefined;

        const itemNeedsAutoRefresh = (item: TeamPanelItem): boolean => {
          if (item.completed) return false;
          if (item.status === "idle/dead" || item.status.includes("dead")) return false;
          return true;
        };

        const shouldAutoRefresh = (): boolean => {
          // Keep an empty team panel live so agents spawned after /team opens appear
          // automatically. Once the panel only has completed/dead entries, stop the
          // timer: repeatedly rereading inbox history and rewrapping final reports is
          // wasteful and can pin the TUI when every agent has finished.
          return items.length === 0 || items.some(itemNeedsAutoRefresh);
        };

        const stopAutoRefresh = () => {
          if (!liveTimer) return;
          clearInterval(liveTimer);
          liveTimer = undefined;
        };

        const applyItems = (nextItems: typeof items, resetLog: boolean) => {
          const selectedName = selectedIndex > 0 ? items[selectedIndex - 1]?.name : undefined;
          items = nextItems;
          if (selectedName) {
            const nextIndex = items.findIndex((item) => item.name === selectedName);
            selectedIndex = nextIndex >= 0 ? nextIndex + 1 : Math.min(selectedIndex, Math.max(0, entryCount() - 1));
          } else {
            selectedIndex = Math.min(selectedIndex, Math.max(0, entryCount() - 1));
          }
          if (resetLog) logOffsetFromBottom = 0;
        };

        function updateAutoRefresh() {
          if (!shouldAutoRefresh()) {
            stopAutoRefresh();
            return;
          }
          if (!liveTimer) {
            liveTimer = setInterval(() => refreshItems({ showLoading: false, resetLog: false }), 1000);
          }
        }

        function refreshItems(refreshOptions: { showLoading: boolean; resetLog: boolean }) {
          if (autoRefreshInFlight) return;
          autoRefreshInFlight = true;
          if (refreshOptions.showLoading) {
            loading = true;
            tui.requestRender();
          }
          void buildTeamPanelItems(panelTeamName!, options)
            .then((nextItems) => applyItems(nextItems, refreshOptions.resetLog))
            .finally(() => {
              autoRefreshInFlight = false;
              loading = false;
              updateAutoRefresh();
              tui.requestRender();
            });
        }

        updateAutoRefresh();

        const refresh = () => refreshItems({ showLoading: true, resetLog: true });

        const formatMainLeftRow = (): string => {
          const mainSelected = selectedIndex === 0;
          return `${mainSelected ? pink("▸") : " "} ${mainSelected ? pink("main") : "main"}  ${dimAnsi("lead")}`;
        };

        const formatItemLeftRow = (entryIndex: number, item: TeamPanelItem): string => {
          const selected = entryIndex === selectedIndex;
          const pointer = selected ? pink("▸") : " ";
          const role = item.completed ? dimAnsi("done") : item.role === "read" ? pink("read") : purple("edit");
          const health = item.completed ? item.status : item.status.includes("dead") ? "dead" : item.status;
          const screen = !item.completed && item.role !== "read" && item.tmuxPaneId
            ? ` ${dimAnsi(item.windowId ? `${item.windowId}/${item.tmuxPaneId}` : item.tmuxPaneId)}`
            : "";
          const requestedBy = item.requestedBy ? ` ${dimAnsi(`requested by ${item.requestedBy}`)}` : "";
          return `${pointer} ${selected ? pink(item.name) : item.name}  ${role}${screen}  ${dimAnsi(health)}${requestedBy}`;
        };

        const renderLeftWindow = (startEntry: number, endEntry: number): string[] => {
          const rows: string[] = [focusedPane === "list" ? pink("views ◂") : purple("views")];
          const totalEntries = entryCount();
          if (startEntry > 0) rows.push(dimAnsi(`… ${startEntry} more above`));

          let completedHeadingShown = false;
          for (let entryIndex = startEntry; entryIndex <= endEntry; entryIndex++) {
            if (entryIndex === 0) {
              rows.push(formatMainLeftRow());
              continue;
            }

            const item = items[entryIndex - 1];
            if (!item) continue;
            const previousItem = entryIndex > 1 ? items[entryIndex - 2] : undefined;
            const singleSelectedRow = startEntry === endEntry && entryIndex === selectedIndex;
            if (!singleSelectedRow && item.completed && (!previousItem?.completed || entryIndex === startEntry) && !completedHeadingShown) {
              rows.push(purple("completed"));
              completedHeadingShown = true;
            }
            rows.push(formatItemLeftRow(entryIndex, item));
          }

          if (endEntry < totalEntries - 1) rows.push(dimAnsi(`… ${totalEntries - 1 - endEntry} more below`));
          return rows;
        };

        const buildLeftRows = (visibleRowLimit: number): string[] => {
          const totalEntries = entryCount();
          const selectableRows = Math.max(1, visibleRowLimit - 4);
          let startEntry = Math.max(0, selectedIndex - Math.floor(selectableRows / 2));
          let endEntry = Math.min(totalEntries - 1, startEntry + selectableRows - 1);
          startEntry = Math.max(0, endEntry - selectableRows + 1);

          let rows = renderLeftWindow(startEntry, endEntry);
          while (rows.length > visibleRowLimit && startEntry < endEntry) {
            if (endEntry > selectedIndex && (selectedIndex - startEntry) <= (endEntry - selectedIndex)) endEntry--;
            else if (startEntry < selectedIndex) startEntry++;
            else endEntry--;
            rows = renderLeftWindow(startEntry, endEntry);
          }
          return rows;
        };

        const summarizeItems = () => {
          let activeReaders = 0;
          let activeWriters = 0;
          let completed = 0;
          for (const item of items) {
            if (item.completed) completed++;
            else if (item.role === "read") activeReaders++;
            else activeWriters++;
          }
          return { activeReaders, activeWriters, completed };
        };

        const buildRightRows = (width: number): string[] => {
          const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(10, width));
          const rows: string[] = [];

          if (selectedIndex === 0) {
            const { activeReaders, activeWriters, completed } = summarizeItems();
            const completedLabel = completed >= MAX_COMPLETED_REPORTS ? `${completed} recent shown` : String(completed);
            rows.push(pink("main · current session"));
            rows.push(focusedPane === "log" ? pink("log pane focused") : dimAnsi("press → to focus log pane"));
            rows.push("");
            rows.push(`${purple("read agents")}   ${activeReaders} (in-process)`);
            rows.push(`${purple("edit agents")}   ${activeWriters} (in-process, followable)`);
            rows.push(`${purple("completed")}     ${completedLabel}`);
            rows.push(`${purple("lead inbox")}    ${options.getLeadInboxUnreadCount()} unread`);
            rows.push("");
            rows.push(dimAnsi("Select an active or completed agent on the left to inspect its live transcript or final output."));
            return rows.flatMap(wrap);
          }

          const item = items[selectedIndex - 1];
          if (!item) return [dimAnsi("No agents.")];

          rows.push(pink(item.name));
          if (item.completed) {
            rows.push(`${purple("status")} ${item.status}   ${purple("completed")} ${item.completedAt ? new Date(item.completedAt).toLocaleString() : "unknown"}`);
            if (item.elapsedMs > 0 || item.tokensUsed > 0) rows.push(`${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
            if (item.requestedBy) rows.push(`${purple("requested by")} ${item.requestedBy}`);
            if (item.summary) rows.push(`${purple("summary")} ${item.summary}`);
            rows.push("");
            rows.push(purple("final output"));
            rows.push(previewLongText(item.reportText || dimAnsi("(completed agent produced no output)")));
            return rows.flatMap(wrap);
          }

          const screen = item.windowId ? `${item.windowId}/${item.tmuxPaneId}` : item.tmuxPaneId;
          rows.push(`${purple("role")} ${item.role}${screen ? ` ${dimAnsi(screen)}` : ""}   ${purple("status")} ${item.status}   ${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
          rows.push(`${purple("model")} ${item.model || "(inherited)"}${item.thinking && item.thinking !== "off" ? `   ${purple("thinking")} ${item.thinking}` : ""}`);
          if (item.requestedBy) rows.push(`${purple("requested by")} ${item.requestedBy}`);
          if (item.role === "read") rows.push(dimAnsi("in-process · followable from Pi"));
          if (item.role === "write") rows.push(dimAnsi("edit-allowed · in-process · followable from Pi"));
          if (item.taskSubjects.length > 0) rows.push(dimAnsi(`tasks: ${item.taskSubjects.slice(0, 4).join(" · ")}`));
          if (item.claimPaths.length > 0) rows.push(dimAnsi(`claims: ${item.claimPaths.slice(0, 4).join(" · ")}`));
          if (item.runtimeStatus?.lastError?.message) rows.push(theme.fg("warning", `error: ${item.runtimeStatus.lastError.message}`));
          rows.push("");

          const session = options.runningReadAgents.get(options.readAgentKey(panelTeamName, item.name))?.session;
          const sessionMessages = Array.isArray(session?.messages) ? session.messages : [];
          const visibleMessages = sessionMessages.length > MAX_TRANSCRIPT_MESSAGES ? sessionMessages.slice(-MAX_TRANSCRIPT_MESSAGES) : sessionMessages;
          const formattedTranscript = visibleMessages.length > 0 ? formatTranscriptLines(visibleMessages) : [];
          const transcript = formattedTranscript.slice(-MAX_TRANSCRIPT_LINES);
          if (transcript.length > 0) {
            rows.push(purple("transcript"));
            if (visibleMessages.length < sessionMessages.length) rows.push(dimAnsi(`showing last ${visibleMessages.length} of ${sessionMessages.length} transcript messages`));
            if (transcript.length < formattedTranscript.length) rows.push(dimAnsi(`showing last ${transcript.length} of ${formattedTranscript.length} transcript lines`));
            for (const line of transcript) rows.push(line);
          } else if (item.recentEvents.length > 0) {
            rows.push(purple("recent"));
            for (const event of item.recentEvents.slice(-RECENT_EVENT_DISPLAY_LIMIT)) rows.push(`  ${event}`);
          } else if (item.tmuxPaneId) {
            rows.push(dimAnsi(`Legacy tmux-backed agent ${screen || "(unknown)"} has no in-process transcript.`));
          } else {
            rows.push(dimAnsi("Waiting for the agent's first turn…"));
          }

          return rows.flatMap(wrap);
        };

        const focusSelectedAgentLog = () => {
          if (selectedIndex === 0) {
            ctx.ui.notify("Select an agent to inspect.", "warning");
            return;
          }
          focusedPane = "log";
          tui.requestRender();
        };

        const shutdownSelected = async () => {
          if (selectedIndex === 0) {
            ctx.ui.notify("Select an agent (not main) to stop.", "warning");
            return;
          }
          const item = items[selectedIndex - 1];
          if (!item) {
            ctx.ui.notify("No agent is selected.", "warning");
            return;
          }
          if (item.completed) {
            ctx.ui.notify(`${item.name} is already completed.`, "info");
            return;
          }

          loading = true;
          tui.requestRender();
          try {
            const config = await teams.readConfig(panelTeamName);
            const member = config.members.find((member) => member.name === item.name && member.name !== "team-lead");
            if (!member) {
              ctx.ui.notify(`Could not find agent ${item.name} in session state.`, "warning");
              return;
            }
            await options.shutdownTeammate(panelTeamName, member);
            items = await buildTeamPanelItems(panelTeamName, options);
            selectedIndex = Math.min(selectedIndex, Math.max(0, items.length));
            ctx.ui.notify(`Stopped ${item.name}.`, "info");
          } catch (error) {
            ctx.ui.notify(`Failed to stop ${item.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
          } finally {
            loading = false;
            tui.requestRender();
          }
        };

        const render = (width: number): string[] => {
          const innerWidth = Math.max(48, width - 4);
          const header: string[] = [];
          header.push(pink("▣ agents") + (loading ? purple("  refreshing…") : ""));
          header.push(dimAnsi("←/→ or h/l: focus list/log   list ↑/↓: select   log ↑/↓: scroll 5   enter/a: focus log   r: refresh   x: stop selected   esc: close"));

          const leftWidth = Math.min(30, Math.max(20, Math.floor(innerWidth * 0.34)));
          const rightWidth = Math.max(20, innerWidth - leftWidth - 3);
          const sep = dimAnsi(" │ ");
          const maxRows = Math.max(8, Math.floor((tui.terminal?.rows ?? 24) * 0.82));
          const bodyHeight = Math.max(3, maxRows - header.length - 3);
          const leftRows = buildLeftRows(bodyHeight);
          const rightRows = buildRightRows(rightWidth);
          const rightStart = logWindowStart(rightRows.length, bodyHeight, logOffsetFromBottom);
          const rightWindow = rightRows.slice(rightStart, rightStart + bodyHeight);

          const content: string[] = [...header, purple("─".repeat(innerWidth))];
          for (let i = 0; i < bodyHeight; i++) {
            const left = truncateToWidth(leftRows[i] ?? "", leftWidth, "…", true);
            const right = truncateToWidth(rightWindow[i] ?? "", rightWidth);
            content.push(`${left}${sep}${right}`);
          }
          // Nested agent transcripts can contain terminal control sequences from
          // tool output (carriage returns, cursor movement, clear-line, etc.).
          // The overlay compositor treats render strings as terminal output, so
          // sanitize every final line before framing to prevent redraw smearing
          // when selection changes with ↑/↓.
          return framePanel(content.map(sanitizeTuiLine), innerWidth);
        };

        return {
          render,
          invalidate() {},
          dispose() {
            stopAutoRefresh();
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
              done();
              return;
            }
            if (isRightInput(data)) {
              focusedPane = "log";
              tui.requestRender();
              return;
            }
            if (isLeftInput(data)) {
              focusedPane = "list";
              tui.requestRender();
              return;
            }
            if (isDownInput(data)) {
              if (focusedPane === "log") logOffsetFromBottom = Math.max(0, logOffsetFromBottom - 5);
              else {
                selectedIndex = Math.min(entryCount() - 1, selectedIndex + 1);
                logOffsetFromBottom = 0;
              }
              tui.requestRender();
              return;
            }
            if (isUpInput(data)) {
              if (focusedPane === "log") logOffsetFromBottom += 5;
              else {
                selectedIndex = Math.max(0, selectedIndex - 1);
                logOffsetFromBottom = 0;
              }
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.enter) || data === "a" || data === "A") {
              focusSelectedAgentLog();
              return;
            }
            if (data === "r" || data === "R") {
              refresh();
              return;
            }
            if (data === "x" || data === "X") {
              void shutdownSelected();
            }
          },
        };
      }, {
        overlay: true,
        overlayOptions: { width: "92%", maxHeight: "84%", anchor: "center" },
      });
    },
  };

  pi.registerCommand("agents", command);
  pi.registerCommand("team", command);
}
