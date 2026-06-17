import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as claims from "../../src/utils/claims";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import { dimAnsi, pink, purple } from "./ansi";
import { framePanel, logWindowStart } from "./frame";
import { isDownInput, isLeftInput, isRightInput, isUpInput } from "./input";
import { formatElapsed, formatTokenCount, formatTranscriptLines } from "./renderers";
import type { CompletedAgentReport, RunningReadAgent } from "../runtime/types";
import type { Member } from "../../src/utils/models";

export interface TeamPanelOptions {
  getTeamName(): string | null | undefined;
  getLeadInboxUnreadCount(): number;
  runningReadAgents: Map<string, RunningReadAgent>;
  completedAgentReports: Map<string, CompletedAgentReport[]>;
  readAgentKey(teamName: string, agentName: string): string;
  terminal: any;
  shutdownTeammate(teamName: string, member: Member): Promise<void>;
}

function inferRequestedBy(summary: string, text: string): string | undefined {
  const source = `${summary}\n${text}`;
  const match = source.match(/(?:completed|failed) for ([A-Za-z0-9_-]+)/);
  return match?.[1];
}

export async function buildTeamPanelItems(panelTeamName: string, options: TeamPanelOptions) {
  const config = await teams.readConfig(panelTeamName);
  const allTasks = await tasks.listTasks(panelTeamName).catch(() => []);
  const allClaims = await claims.listClaims(panelTeamName).catch(() => []);
  const items = [] as Array<{
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
    completed: boolean;
    completedAt?: number;
    summary?: string;
    reportText?: string;
    requestedBy?: string;
  }>;

  for (const member of config.members.filter((m) => m.name !== "team-lead")) {
    const readState = options.runningReadAgents.get(options.readAgentKey(panelTeamName, member.name));
    const runtimeStatus = await runtime.readRuntimeStatus(panelTeamName, member.name).catch(() => null);
    const unreadCount = (await messaging.readInbox(panelTeamName, member.name, true, false).catch(() => [])).length;
    const role = member.role || "write";
    const alive = role === "read"
      ? !!readState || !!runtimeStatus?.ready
      : !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId));
    const status = readState?.status || runtimeStatus?.currentAction || (alive ? "running" : "idle/dead");
    const startedAt = readState?.startedAt || runtimeStatus?.startedAt || member.joinedAt;
    const tokensUsed = readState?.tokensUsed ?? runtimeStatus?.tokensUsed ?? 0;

    items.push({
      name: member.name,
      role,
      status,
      model: member.model,
      thinking: member.thinking,
      unreadCount,
      elapsedMs: Date.now() - startedAt,
      tokensUsed,
      taskSubjects: allTasks
        .filter((task: any) => task.owner === member.name && task.status !== "completed" && task.status !== "deleted")
        .map((task: any) => `#${task.id} ${task.subject}`),
      claimPaths: allClaims.filter((claim) => claim.agent === member.name).map((claim) => claim.path),
      recentEvents: readState?.recentEvents || [],
      runtimeStatus,
      tmuxPaneId: member.tmuxPaneId,
      completed: false,
      requestedBy: member.requestedBy,
    });
  }

  const leadInboxMessages = await messaging.readInbox(panelTeamName, "team-lead", false, false).catch(() => []);
  const completedFromInbox: CompletedAgentReport[] = leadInboxMessages
    .filter((message: any) => {
      const from = String(message.from || "");
      return from && from !== "team-lead" && from !== "system" && from !== "watchdog";
    })
    .map((message: any) => {
      const summary = String(message.summary || "Final report");
      const text = String(message.text || "");
      const role = summary.startsWith("Read helper ") || summary.startsWith("Read agent ") ? "read" : "write";
      return {
        name: String(message.from),
        role,
        status: "completed" as const,
        report: text,
        summary,
        completedAt: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
        color: message.color,
        requestedBy: inferRequestedBy(summary, text),
        source: "lead-inbox" as const,
      };
    });

  const completed = [...(options.completedAgentReports.get(panelTeamName) ?? []), ...completedFromInbox]
    .filter((report) => report.report.trim().length > 0)
    .sort((a, b) => b.completedAt - a.completedAt);
  const seenCompleted = new Set<string>();
  for (const report of completed) {
    const dedupeKey = `${report.name}:${report.completedAt}:${report.summary || ""}`;
    if (seenCompleted.has(dedupeKey)) continue;
    seenCompleted.add(dedupeKey);
    items.push({
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
    });
  }

  return items.sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) return (b.completedAt || 0) - (a.completedAt || 0);
    return a.name.localeCompare(b.name);
  });
}

export function registerTeamCommand(pi: any, options: TeamPanelOptions): void {
  pi.registerCommand("team", {
    description: "Switch between main + teammates (↑/↓), refresh (r), or stop selected teammate (x).",
    handler: async (args: string, ctx: any) => {
      const panelTeamName = args.trim() || options.getTeamName();
      if (!panelTeamName) {
        ctx.ui.notify("No current team. Pass a team name: /team <name>", "warning");
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

        const refreshItems = (refreshOptions: { showLoading: boolean; resetLog: boolean }) => {
          if (autoRefreshInFlight) return;
          autoRefreshInFlight = true;
          if (refreshOptions.showLoading) {
            loading = true;
            tui.requestRender();
          }
          void buildTeamPanelItems(panelTeamName, options)
            .then((nextItems) => applyItems(nextItems, refreshOptions.resetLog))
            .finally(() => {
              autoRefreshInFlight = false;
              loading = false;
              tui.requestRender();
            });
        };

        const liveTimer = setInterval(() => refreshItems({ showLoading: false, resetLog: false }), 1000);

        const refresh = () => refreshItems({ showLoading: true, resetLog: true });

        const buildLeftRows = (): string[] => {
          const rows: string[] = [focusedPane === "list" ? pink("views ◂") : purple("views")];
          const mainSelected = selectedIndex === 0;
          rows.push(`${mainSelected ? pink("▸") : " "} ${mainSelected ? pink("main") : "main"}  ${dimAnsi("lead")}`);
          let completedHeadingShown = false;
          for (const [index, item] of items.entries()) {
            if (item.completed && !completedHeadingShown) {
              rows.push("");
              rows.push(purple("completed"));
              completedHeadingShown = true;
            }
            const selected = index + 1 === selectedIndex;
            const pointer = selected ? pink("▸") : " ";
            const role = item.completed ? dimAnsi("done") : item.role === "read" ? pink("read") : purple("write");
            const health = item.completed ? item.status : item.status.includes("dead") ? "dead" : item.status;
            const pane = !item.completed && item.role !== "read" && item.tmuxPaneId ? ` ${dimAnsi(item.tmuxPaneId)}` : "";
            const requestedBy = item.requestedBy ? ` ${dimAnsi(`requested by ${item.requestedBy}`)}` : "";
            rows.push(`${pointer} ${selected ? pink(item.name) : item.name}  ${role}${pane}  ${dimAnsi(health)}${requestedBy}`);
          }
          return rows;
        };

        const buildRightRows = (width: number): string[] => {
          const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(10, width));
          const rows: string[] = [];

          if (selectedIndex === 0) {
            const activeReaders = items.filter((item) => !item.completed && item.role === "read");
            const activeWriters = items.filter((item) => !item.completed && item.role !== "read");
            const completed = items.filter((item) => item.completed);
            rows.push(pink(`main · ${panelTeamName}`));
            rows.push(focusedPane === "log" ? pink("log pane focused") : dimAnsi("press → to focus log pane"));
            rows.push("");
            rows.push(`${purple("read agents")}   ${activeReaders.length} (in-process)`);
            rows.push(`${purple("write agents")}  ${activeWriters.length} (tmux panes)`);
            rows.push(`${purple("completed")}     ${completed.length}`);
            rows.push(`${purple("lead inbox")}    ${options.getLeadInboxUnreadCount()} unread`);
            rows.push("");
            rows.push(dimAnsi("Select an active or completed agent on the left to inspect its live transcript or final output."));
            return rows.flatMap(wrap);
          }

          const item = items[selectedIndex - 1];
          if (!item) return [dimAnsi("No teammates.")];

          rows.push(pink(item.name));
          if (item.completed) {
            rows.push(`${purple("status")} ${item.status}   ${purple("completed")} ${item.completedAt ? new Date(item.completedAt).toLocaleString() : "unknown"}`);
            if (item.elapsedMs > 0 || item.tokensUsed > 0) rows.push(`${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
            if (item.requestedBy) rows.push(`${purple("requested by")} ${item.requestedBy}`);
            if (item.summary) rows.push(`${purple("summary")} ${item.summary}`);
            rows.push("");
            rows.push(purple("final output"));
            rows.push(item.reportText || dimAnsi("(completed agent produced no output)"));
            return rows.flatMap(wrap);
          }

          rows.push(`${purple("role")} ${item.role}${item.tmuxPaneId ? ` ${dimAnsi(item.tmuxPaneId)}` : ""}   ${purple("status")} ${item.status}   ${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
          rows.push(`${purple("model")} ${item.model || "(inherited)"}${item.thinking && item.thinking !== "off" ? `   ${purple("thinking")} ${item.thinking}` : ""}`);
          if (item.requestedBy) rows.push(`${purple("requested by")} ${item.requestedBy}`);
          if (item.role === "read") rows.push(dimAnsi("in-process · promote_teammate moves it into a tmux pane"));
          if (item.taskSubjects.length > 0) rows.push(dimAnsi(`tasks: ${item.taskSubjects.slice(0, 4).join(" · ")}`));
          if (item.claimPaths.length > 0) rows.push(dimAnsi(`claims: ${item.claimPaths.slice(0, 4).join(" · ")}`));
          if (item.runtimeStatus?.lastError?.message) rows.push(theme.fg("warning", `error: ${item.runtimeStatus.lastError.message}`));
          rows.push("");

          if (item.role === "read") {
            const session = options.runningReadAgents.get(options.readAgentKey(panelTeamName, item.name))?.session;
            const transcript = session ? formatTranscriptLines(session.messages) : [];
            if (transcript.length > 0) {
              rows.push(purple("transcript"));
              for (const line of transcript) rows.push(line);
            } else if (item.recentEvents.length > 0) {
              rows.push(purple("recent"));
              for (const event of item.recentEvents.slice(-12)) rows.push(`  ${event}`);
            } else {
              rows.push(dimAnsi("Waiting for the read agent's first turn…"));
            }
          } else {
            rows.push(dimAnsi(`Write agent runs in tmux pane ${item.tmuxPaneId || "(unknown)"}${item.runtimeStatus?.pid ? ` (pid ${item.runtimeStatus.pid})` : ""}.`));
            rows.push(dimAnsi("Switch to that pane to see its full transcript."));
            if (item.recentEvents.length > 0) {
              rows.push("");
              rows.push(purple("recent"));
              for (const event of item.recentEvents.slice(-12)) rows.push(`  ${event}`);
            }
          }

          return rows.flatMap(wrap);
        };

        const shutdownSelected = async () => {
          if (selectedIndex === 0) {
            ctx.ui.notify("Select a teammate (not main) to stop.", "warning");
            return;
          }
          const item = items[selectedIndex - 1];
          if (!item) {
            ctx.ui.notify("No teammate is selected.", "warning");
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
              ctx.ui.notify(`Could not find member ${item.name} in team config.`, "warning");
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
          header.push(pink(`▣ team ${panelTeamName}`) + (loading ? purple("  refreshing…") : ""));
          header.push(dimAnsi("←/→ or h/l: focus list/log   list ↑/↓: select   log ↑/↓: scroll 5   r: refresh   x: stop selected   esc: close"));

          const leftWidth = Math.min(30, Math.max(20, Math.floor(innerWidth * 0.34)));
          const rightWidth = Math.max(20, innerWidth - leftWidth - 3);
          const sep = dimAnsi(" │ ");
          const maxRows = Math.max(8, Math.floor((tui.terminal?.rows ?? 24) * 0.82));
          const bodyHeight = Math.max(3, maxRows - header.length - 3);
          const leftRows = buildLeftRows();
          const rightRows = buildRightRows(rightWidth);
          const rightStart = logWindowStart(rightRows.length, bodyHeight, logOffsetFromBottom);
          const rightWindow = rightRows.slice(rightStart, rightStart + bodyHeight);

          const content: string[] = [...header, purple("─".repeat(innerWidth))];
          for (let i = 0; i < bodyHeight; i++) {
            const left = truncateToWidth(leftRows[i] ?? "", leftWidth, "…", true);
            const right = truncateToWidth(rightWindow[i] ?? "", rightWidth);
            content.push(`${left}${sep}${right}`);
          }
          return framePanel(content, innerWidth);
        };

        return {
          render,
          invalidate() {},
          dispose() {
            clearInterval(liveTimer);
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
  });
}
