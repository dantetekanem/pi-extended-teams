import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { isReadAgentHerdrHandoffEligible, readAgentHerdrHandoffMode } from "../runtime/types";
import type { RunningReadAgent } from "../runtime/types";
import { initialContextUsage } from "../../src/utils/runtime";
import { createFramePanelRowRenderer, framePanel, type FramePanelStyle } from "./frame";
import { extractTextParts, formatAnimatedProgress, formatContextUsage, formatElapsed, formatModelLabel, sanitizePlainTuiLine, sanitizeTuiLine, sanitizeTuiText } from "./renderers";
import { resolveExtendedTeamsTheme, type ExtendedTeamsForegroundToken, type ExtendedTeamsTheme } from "./theme";

const REFRESH_INTERVAL_MS = 250;
const MAX_NAVIGATION_AGENTS = 6;
const COLLAPSED_TOOL_RESULT_LINE_LIMIT = 14;
const COLLAPSED_TOOL_RESULT_HEAD_LINES = 8;
const COLLAPSED_TOOL_RESULT_TAIL_LINES = 3;

export interface AgentFollowViewOptions {
  getAgents(): RunningReadAgent[];
  initialAgentName?: string;
  interruptAgent?(name: string): void | Promise<void>;
  handoffAgent?(name: string): void | Promise<void>;
  stopAgent?(name: string): void | Promise<void>;
  sendMessage?(name: string, content: string): void | Promise<void>;
}

export function isHerdrHandoffEligible(agent: RunningReadAgent): boolean {
  return isReadAgentHerdrHandoffEligible(agent);
}

export interface AgentFollowTranscriptOptions {
  expandLargeToolResults?: boolean;
  width?: number;
  theme?: ExtendedTeamsTheme;
}

type TranscriptBlock =
  | { kind: "section"; label: "user" | "thinking" | "assistant"; text: string }
  | { kind: "tool"; id?: string; name: string; args: unknown; result?: string; details?: unknown; isError?: boolean };

function stringifyToolArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function compactToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return sanitizeTuiLine(stringifyToolArgs(args));
  const values = args as Record<string, unknown>;
  const primary = name === "bash"
    ? values.command
    : name === "read"
      ? values.path
      : name === "agentic_search"
        ? values.query
        : undefined;
  const raw = primary === undefined ? JSON.stringify(values) : String(primary);
  const compact = sanitizeTuiLine(raw).replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 239)}…` : compact;
}

function formatResultSize(text: string): string {
  const size = Buffer.byteLength(text, "utf8");
  if (size < 1_024) return `${size} B`;
  return `${(size / 1_024).toFixed(size < 10_240 ? 1 : 0)} KB`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactTranscriptLine(text: string): string {
  return sanitizePlainTuiLine(text).replace(/\s+/g, " ").trim();
}

function themed(theme: ExtendedTeamsTheme, token: ExtendedTeamsForegroundToken, text: string): string {
  return theme.fg(token, text);
}

function actionText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "syntaxFunction", text);
}

function pathText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "syntaxString", text);
}

function successText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "success", text);
}

function failureText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "error", text);
}

function pendingText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "warning", text);
}

function bodyText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "text", text);
}

function mutedText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "muted", text);
}

function structuralText(theme: ExtendedTeamsTheme, text: string): string {
  return themed(theme, "borderAccent", text);
}

function boundTranscriptLine(line: string, width?: number): string {
  return width === undefined ? line : truncateToWidth(line, Math.max(1, width), "…");
}

function toolPath(args: unknown): string {
  const path = asRecord(args)?.path;
  return compactTranscriptLine(typeof path === "string" ? path : "(unknown file)");
}

function toolPaths(args: unknown): string {
  const paths = asRecord(args)?.paths;
  if (!Array.isArray(paths)) return toolPath(args);
  const compactPaths = paths
    .filter((path): path is string => typeof path === "string")
    .map(compactTranscriptLine)
    .filter(Boolean);
  return compactPaths.length > 0 ? compactPaths.join(", ") : "(unknown file)";
}

function editDiffCounts(details: unknown): { added: number; removed: number } | undefined {
  const diff = asRecord(details)?.diff;
  if (typeof diff !== "string") return undefined;

  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+(?:\s|$)/.test(line)) added += 1;
    else if (/^-\s*\d+(?:\s|$)/.test(line)) removed += 1;
  }
  return { added, removed };
}

function renderState(theme: ExtendedTeamsTheme, state: string): string {
  if (state === "failed") return failureText(theme, state);
  if (state === "working" || state === "submitting") return pendingText(theme, state);
  if (state === "duplicate") return mutedText(theme, state);
  return successText(theme, state);
}

function renderActionPathState(theme: ExtendedTeamsTheme, action: string, path: string, state: string, width?: number): string {
  const renderedState = state === "failed"
    ? failureText(theme, "✗")
    : state === "succeeded"
      ? successText(theme, "✓")
      : renderState(theme, state);
  return boundTranscriptLine(
    `${actionText(theme, action)}${mutedText(theme, " · ")}${pathText(theme, path)}${mutedText(theme, " · ")}${renderedState}`,
    width,
  );
}

function renderCompactToolBlock(theme: ExtendedTeamsTheme, block: Extract<TranscriptBlock, { kind: "tool" }>, width?: number): string[] | undefined {
  if (block.name === "report_progress") {
    const details = asRecord(block.details);
    const args = asRecord(block.args);
    const resultStatus = block.result?.replace(/^Progress (?:updated|update skipped):\s*/i, "");
    const rawStatus = details?.status ?? args?.status ?? resultStatus ?? "updating";
    const status = compactTranscriptLine(String(rawStatus)) || "updating";
    const failureSuffix = block.isError ? " (failed)" : "";
    return [boundTranscriptLine(`${status}${failureSuffix}`, width), ""];
  }

  if (block.name === "edit") {
    const path = toolPath(block.args);
    if (block.result === undefined) return [renderActionPathState(theme, "edit", path, "working", width)];
    if (block.isError) return [renderActionPathState(theme, "edit", path, "failed", width)];
    const counts = editDiffCounts(block.details);
    const added = counts ? `+${counts.added}` : "+?";
    const removed = counts ? `−${counts.removed}` : "−?";
    return [boundTranscriptLine(
      `${actionText(theme, "edit")}${mutedText(theme, " · ")}${pathText(theme, path)}${mutedText(theme, " · ")}${successText(theme, added)} ${failureText(theme, removed)}${mutedText(theme, " · ")}${successText(theme, "✓")}`,
      width,
    )];
  }

  if (block.name === "write") {
    const state = block.result === undefined ? "working" : block.isError ? "failed" : "succeeded";
    return [renderActionPathState(theme, "write", toolPath(block.args), state, width)];
  }

  if (block.name === "claim_file" || block.name === "release_file") {
    const details = asRecord(block.details);
    const conflicts = Array.isArray(details?.conflicts) ? details.conflicts : [];
    const state = block.result === undefined
      ? "working"
      : block.isError || conflicts.length > 0
        ? "failed"
        : "succeeded";
    const action = block.name === "claim_file" ? "claim" : "release";
    return [renderActionPathState(theme, action, toolPaths(block.args), state, width)];
  }

  if (block.name === "report_and_exit") {
    const accepted = asRecord(block.details)?.accepted;
    const state = block.result === undefined
      ? "submitting"
      : block.isError
        ? "failed"
        : accepted === false
          ? "duplicate"
          : "accepted";
    return [boundTranscriptLine(`${actionText(theme, "final report")}${mutedText(theme, " · ")}${renderState(theme, state)}`, width)];
  }

  return undefined;
}

function renderToolHeader(theme: ExtendedTeamsTheme, block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  const detail = compactToolArgs(block.name, block.args);
  if (!detail) return actionText(theme, block.name);
  const isPath = typeof asRecord(block.args)?.path === "string";
  const renderedDetail = isPath ? pathText(theme, detail) : bodyText(theme, `${block.name === "bash" ? "$ " : ""}${detail}`);
  return `${actionText(theme, block.name)}${mutedText(theme, " · ")}${renderedDetail}`;
}

function renderToolBlock(theme: ExtendedTeamsTheme, block: Extract<TranscriptBlock, { kind: "tool" }>, expandLargeToolResults: boolean, width?: number): string[] {
  const compactBlock = renderCompactToolBlock(theme, block, width);
  if (compactBlock) return compactBlock;

  const header = renderToolHeader(theme, block);
  if (block.result === undefined) {
    return [header, `${structuralText(theme, "│")} ${pendingText(theme, "waiting for result…")}`, `${structuralText(theme, "╰─")} ${pendingText(theme, "running")}`, ""];
  }

  const result = block.result || "(no output)";
  const resultLines = result.split("\n");
  const isCollapsed = !expandLargeToolResults && resultLines.length > COLLAPSED_TOOL_RESULT_LINE_LIMIT;
  const visibleLines = isCollapsed
    ? [
        ...resultLines.slice(0, COLLAPSED_TOOL_RESULT_HEAD_LINES),
        `… ${resultLines.length - COLLAPSED_TOOL_RESULT_HEAD_LINES - COLLAPSED_TOOL_RESULT_TAIL_LINES} lines hidden · press l to expand logs`,
        ...resultLines.slice(-COLLAPSED_TOOL_RESULT_TAIL_LINES),
      ]
    : resultLines;
  const resultLineWidth = width === undefined ? undefined : Math.max(1, width - visibleWidth("│ "));
  const boundedLines = visibleLines.map((line) => resultLineWidth === undefined
    ? line
    : truncateToWidth(line, resultLineWidth, "…"));
  const body = boundedLines.map((line, index) => isCollapsed && index === COLLAPSED_TOOL_RESULT_HEAD_LINES
    ? `${structuralText(theme, "│")} ${mutedText(theme, line)}`
    : `${structuralText(theme, "│")} ${line}`);
  const summary = `${resultLines.length} line${resultLines.length === 1 ? "" : "s"} · ${formatResultSize(result)}${isCollapsed ? " · collapsed" : ""}`;
  const renderedSummary = block.isError ? failureText(theme, summary) : successText(theme, summary);
  return [header, ...body, `${structuralText(theme, "╰─")} ${renderedSummary}`, ""];
}

export function formatAgentFollowTranscript(messages: any[], options: AgentFollowTranscriptOptions = {}): string[] {
  const theme = resolveExtendedTeamsTheme(options.theme);
  const blocks: TranscriptBlock[] = [];
  const toolsById = new Map<string, Extract<TranscriptBlock, { kind: "tool" }>>();

  for (const message of messages || []) {
    if (message?.role === "user") {
      const text = sanitizeTuiText(extractTextParts(message.content));
      if (text) blocks.push({ kind: "section", label: "user", text });
      continue;
    }

    if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          blocks.push({ kind: "section", label: "thinking", text: sanitizeTuiText(part.thinking.trim()) });
        } else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          blocks.push({ kind: "section", label: "assistant", text: sanitizeTuiText(part.text.trim()) });
        } else if (part?.type === "toolCall") {
          const id = typeof part.id === "string" ? part.id : typeof part.toolCallId === "string" ? part.toolCallId : undefined;
          const tool: Extract<TranscriptBlock, { kind: "tool" }> = {
            kind: "tool",
            id,
            name: sanitizeTuiLine(String(part.name || "unknown")),
            args: part.arguments ?? part.args,
          };
          blocks.push(tool);
          if (id) toolsById.set(id, tool);
        }
      }
      continue;
    }

    if (message?.role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const name = sanitizeTuiLine(String(message.toolName || "tool"));
      const matchingTool = (id ? toolsById.get(id) : undefined)
        ?? blocks.slice().reverse().find((block): block is Extract<TranscriptBlock, { kind: "tool" }> => block.kind === "tool" && block.result === undefined && block.name === name);
      const result = sanitizeTuiText(extractTextParts(message.content));
      const isError = typeof message.isError === "boolean" ? message.isError : undefined;
      if (matchingTool) {
        matchingTool.result = result;
        matchingTool.details = message.details;
        matchingTool.isError = isError;
      } else {
        blocks.push({ kind: "tool", id, name, args: undefined, result, details: message.details, isError });
      }
    }
  }

  const lines = blocks.flatMap(block => {
    if (block.kind === "tool") {
      return renderToolBlock(theme, block, options.expandLargeToolResults === true, options.width);
    }
    if (block.label === "thinking") {
      return [theme.fg("thinkingText", block.label), block.text.replace(/\*\*/g, ""), ""];
    }
    const labelToken = block.label === "user" ? "customMessageLabel" : "accent";
    return [theme.fg(labelToken, block.label), block.text, ""];
  });
  return lines.length > 0 ? lines : [theme.fg("dim", "Waiting for the agent's first transcript event…")];
}

function currentAgent(agents: RunningReadAgent[], selectedName: string | undefined): RunningReadAgent | undefined {
  return agents.find(agent => agent.name === selectedName) ?? agents[0];
}

export function createAgentFollowComponent(
  tui: any,
  done: () => void,
  options: AgentFollowViewOptions,
  providedTheme?: ExtendedTeamsTheme
) {
  const theme = resolveExtendedTeamsTheme(providedTheme);
  // Herdr reserves plain page keys for primary-screen scrollback unless an app owns mouse input.
  const forwardHerdrPageKeys = process.env.HERDR_ENV === "1" && tui.mode !== "fullscreen" && typeof tui.terminal?.write === "function";
  if (forwardHerdrPageKeys) tui.terminal.write("\x1b[?1000h");
  const frameStyle: FramePanelStyle = {
    border: (text) => theme.fg("borderAccent", text),
    background: (text) => theme.bg("toolPendingBg", text),
  };
  let selectedName = options.initialAgentName;
  let offsetFromBottom = 0;
  let lastBodyHeight = 10;
  let lastTranscriptRows = 0;
  let expandLargeToolResults = false;
  let composingMessage = false;
  let sendingMessage = false;
  let messageStatus = "";
  let focused = false;
  const messageInput = new Input();
  const interruptingAgents = new Set<string>();
  const handoffAgents = new Set<string>();
  const stoppingAgents = new Set<string>();
  const canHandoff = (agent: RunningReadAgent) => !!options.handoffAgent
    && isHerdrHandoffEligible(agent)
    && !handoffAgents.has(agent.name)
    && !stoppingAgents.has(agent.name);
  let handoffStatus = "";
  let transcriptAgent: RunningReadAgent | undefined;
  let transcriptMessages: unknown[] | undefined;
  let transcriptMessageCount = -1;
  let transcriptLastMessage: unknown;
  let transcriptWidth = -1;
  let transcriptExpanded = false;
  let cachedTranscriptLines: string[] = [];
  let cachedFrameWidth = -1;
  let cachedFrameRowRenderer: ((line: string) => string) | undefined;
  let cachedFrameContent: string[] | null = null;
  let cachedFrameLines: string[] | null = null;
  let fastFrameKey = "";
  let fastFrameMessages: unknown[] | undefined;
  let fastFrameMessageCount = -1;
  let fastFrameLastMessage: unknown;
  let refreshStateKey = "";
  let refreshMessages: unknown[] | undefined;
  let refreshMessageCount = -1;
  let refreshLastMessage: unknown;
  const refreshTimer = setInterval(() => {
    const agents = options.getAgents().slice().sort((a, b) => a.name.localeCompare(b.name));
    const agent = currentAgent(agents, selectedName);
    if (!agent) {
      const emptyKey = agents.map((item) => item.name).join("\0");
      if (emptyKey !== refreshStateKey) {
        refreshStateKey = emptyKey;
        tui.requestRender();
      }
      return;
    }

    try {
      const session = agent.session;
      const stats = session?.getSessionStats();
      if (stats) {
        agent.tokensUsed = stats.tokens.total;
        const contextUsage = stats.contextUsage ?? session?.getContextUsage?.();
        agent.contextUsage = stats.tokens.total > 0
          ? contextUsage
          : initialContextUsage(contextUsage?.contextWindow);
      }
    } catch {
      // The nested session may be shutting down while this view refreshes.
    }
    const messages = agent.session?.messages || [];
    const lastMessage = messages[messages.length - 1];
    const stateKey = [
      Math.floor(Date.now() / 1000),
      agents.map((item) => item.name).join(","),
      agent.name,
      agent.model,
      agent.thinking,
      agent.modelSlot,
      agent.startedAt,
      agent.tokensUsed,
      formatContextUsage(agent.contextUsage),
      agent.status,
      agent.latestProgress,
      interruptingAgents.has(agent.name),
      handoffAgents.has(agent.name),
      stoppingAgents.has(agent.name),
      canHandoff(agent),
      handoffStatus,
      expandLargeToolResults,
      offsetFromBottom,
      composingMessage,
      messageStatus,
      tui.terminal?.rows ?? 24,
    ].join("\0");
    if (stateKey === refreshStateKey
      && refreshMessages === messages
      && refreshMessageCount === messages.length
      && refreshLastMessage === lastMessage) {
      return;
    }
    refreshStateKey = stateKey;
    refreshMessages = messages;
    refreshMessageCount = messages.length;
    refreshLastMessage = lastMessage;
    tui.requestRender();
  }, REFRESH_INTERVAL_MS);

  const syncInputFocus = () => {
    messageInput.focused = focused && composingMessage;
  };

  const stopComposingMessage = () => {
    composingMessage = false;
    messageInput.setValue("");
    syncInputFocus();
    tui.requestRender();
  };

  messageInput.onEscape = stopComposingMessage;
  messageInput.onSubmit = (value: string) => {
    const content = value.trim();
    const agent = currentAgent(sortedAgents(), selectedName);
    if (!content || !agent || !options.sendMessage || sendingMessage) {
      if (!content) messageStatus = "Write a message before sending.";
      tui.requestRender();
      return;
    }

    const recipient = agent.name;
    sendingMessage = true;
    messageStatus = `Sending to ${recipient}…`;
    tui.requestRender();
    void Promise.resolve()
      .then(() => options.sendMessage?.(recipient, content))
      .then(() => {
        messageStatus = `Message sent to ${recipient}.`;
        stopComposingMessage();
      })
      .catch((error: unknown) => {
        messageStatus = error instanceof Error ? error.message : `Could not message ${recipient}.`;
        tui.requestRender();
      })
      .finally(() => {
        sendingMessage = false;
        tui.requestRender();
      });
  };

  const sortedAgents = () => options.getAgents().slice().sort((a, b) => a.name.localeCompare(b.name));

  const selectRelative = (delta: number) => {
    const agents = sortedAgents();
    if (agents.length === 0) return;
    const selected = currentAgent(agents, selectedName);
    const currentIndex = Math.max(0, agents.findIndex(agent => agent.name === selected?.name));
    selectedName = agents[(currentIndex + delta + agents.length) % agents.length]?.name;
    offsetFromBottom = 0;
  };

  const selectPreviousOrMain = () => {
    const agents = sortedAgents();
    const selected = currentAgent(agents, selectedName);
    const currentIndex = agents.findIndex(agent => agent.name === selected?.name);
    if (currentIndex <= 0) {
      done();
      return;
    }
    selectedName = agents[currentIndex - 1]?.name;
    offsetFromBottom = 0;
    tui.requestRender();
  };

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      syncInputFocus();
    },
    render(width: number): string[] {
      const agents = sortedAgents();
      const agent = currentAgent(agents, selectedName);
      const innerWidth = Math.max(40, width - 4);
      const terminalRows = Math.max(12, tui.terminal?.rows ?? 24);

      if (!agent) {
        const emptyBodyHeight = Math.max(4, terminalRows - 6);
        return framePanel([
          theme.fg("accent", "agent navigation"),
          theme.fg("borderAccent", "↑  main agent"),
          theme.fg("dim", "No active agents. Press ↑ or esc to return to main."),
          ...Array.from({ length: emptyBodyHeight }, () => ""),
        ], innerWidth, frameStyle);
      }

      const selectedIndex = Math.max(0, agents.findIndex(item => item.name === agent.name));
      const navigationStart = Math.max(0, Math.min(selectedIndex - 2, agents.length - MAX_NAVIGATION_AGENTS));
      const visibleAgents = agents.slice(navigationStart, navigationStart + MAX_NAVIGATION_AGENTS);
      const navigationLines = [theme.fg("accent", "agent navigation"), theme.fg("borderAccent", "↑  main agent")];
      if (navigationStart > 0) navigationLines.push(theme.fg("dim", `   … ${navigationStart} agent${navigationStart === 1 ? "" : "s"} above`));
      for (const item of visibleAgents) {
        const selected = item.name === agent.name;
        navigationLines.push(`${selected ? theme.fg("accent", "->") : "  "} ${item.name}`);
      }
      const remainingAgents = agents.length - navigationStart - visibleAgents.length;
      if (remainingAgents > 0) navigationLines.push(theme.fg("dim", `↓  … ${remainingAgents} more agent${remainingAgents === 1 ? "" : "s"}`));

      const messageLines = options.sendMessage ? [
        theme.fg("border", "─".repeat(innerWidth)),
        composingMessage ? theme.fg("accent", `message ${agent.name}`) : theme.fg("dim", `message ${agent.name}`),
        ...(composingMessage ? messageInput.render(innerWidth) : [theme.fg("dim", "> Press m to start typing")]),
        ...(messageStatus
          ? [theme.fg("dim", messageStatus)]
          : composingMessage ? [theme.fg("dim", "enter send · esc cancel")] : []),
      ] : [];
      const handoffLines = handoffStatus ? [theme.fg("dim", handoffStatus)] : [];
      const bodyHeight = Math.max(4, terminalRows - navigationLines.length - 6 - messageLines.length - handoffLines.length);
      lastBodyHeight = bodyHeight;

      selectedName = agent.name;
      try {
        const session = agent.session;
        const stats = session?.getSessionStats();
        if (stats) {
          agent.tokensUsed = stats.tokens.total;
          const contextUsage = stats.contextUsage ?? session?.getContextUsage?.();
          agent.contextUsage = stats.tokens.total > 0
            ? contextUsage
            : initialContextUsage(contextUsage?.contextWindow);
        }
      } catch {
        // The nested session may be shutting down while this view renders.
      }

      const currentMessages = agent.session?.messages || [];
      const lastMessage = currentMessages[currentMessages.length - 1];
      const renderNow = Date.now();
      const isInterrupting = interruptingAgents.has(agent.name);
      const isHandoff = handoffAgents.has(agent.name);
      const isStopping = stoppingAgents.has(agent.name);
      const currentFastFrameKey = composingMessage ? "" : [
        innerWidth,
        terminalRows,
        Math.floor(renderNow / 1000),
        agents.map((item) => item.name).join(","),
        selectedName,
        agent.model,
        agent.thinking,
        agent.modelSlot,
        agent.startedAt,
        agent.tokensUsed,
        formatContextUsage(agent.contextUsage),
        agent.status,
        agent.latestProgress,
        isInterrupting,
        isHandoff,
        isStopping,
        canHandoff(agent),
        handoffStatus,
        expandLargeToolResults,
        offsetFromBottom,
        messageStatus,
        options.sendMessage ? 1 : 0,
      ].join("\0");
      if (currentFastFrameKey
        && currentFastFrameKey === fastFrameKey
        && fastFrameMessages === currentMessages
        && fastFrameMessageCount === currentMessages.length
        && fastFrameLastMessage === lastMessage
        && cachedFrameLines) {
        return cachedFrameLines.slice();
      }
      const model = formatModelLabel(agent.model, agent.thinking).replace(" · ", "/");
      const slot = agent.modelSlot || "level inherited";
      const elapsed = formatElapsed(renderNow - agent.startedAt);
      const activity = isStopping
        ? "stopping"
        : isHandoff
          ? "moving to Herdr"
          : isInterrupting
            ? "interrupting"
            : agent.latestProgress
            ? formatAnimatedProgress(agent.latestProgress, renderNow)
            : agent.status;
      const headline = `(${agent.name}) ${model} · ${slot} · ${elapsed} · ${formatContextUsage(agent.contextUsage)} · ${activity}`;
      const logAction = expandLargeToolResults ? "l collapse logs" : "l expand logs";
      const messageAction = options.sendMessage ? " · m message" : "";
      const interruptAction = options.interruptAgent ? " · i interrupt" : "";
      const handoffAction = canHandoff(agent)
        ? ` · h ${readAgentHerdrHandoffMode(agent) === "retry" ? "Retry Herdr" : "Herdr"}`
        : "";
      const help = composingMessage
        ? `message ${agent.name} · enter send · esc cancel`
        : agents.length > 1
          ? `↑ previous/main · ↓ next agent · ←/→ agent · ${logAction}${messageAction}${interruptAction}${handoffAction} · x stop · pgup/pgdn scroll · esc main`
          : `↑/esc main · ${logAction}${messageAction}${interruptAction}${handoffAction} · x stop · pgup/pgdn scroll · end follow`;

      const currentTranscriptWidth = Math.max(20, innerWidth);
      if (transcriptAgent !== agent
        || transcriptMessages !== currentMessages
        || transcriptMessageCount !== currentMessages.length
        || transcriptLastMessage !== lastMessage
        || transcriptWidth !== currentTranscriptWidth
        || transcriptExpanded !== expandLargeToolResults) {
        transcriptAgent = agent;
        transcriptMessages = currentMessages;
        transcriptMessageCount = currentMessages.length;
        transcriptLastMessage = lastMessage;
        transcriptWidth = currentTranscriptWidth;
        transcriptExpanded = expandLargeToolResults;
        cachedTranscriptLines = formatAgentFollowTranscript(currentMessages, {
          expandLargeToolResults,
          width: currentTranscriptWidth,
          theme,
        }).flatMap(line => wrapTextWithAnsi(line, currentTranscriptWidth));
      }
      const transcriptLines = cachedTranscriptLines;
      lastTranscriptRows = transcriptLines.length;
      const maxOffset = Math.max(0, transcriptLines.length - bodyHeight);
      offsetFromBottom = Math.min(offsetFromBottom, maxOffset);
      const start = Math.max(0, maxOffset - offsetFromBottom);
      const visible = transcriptLines.slice(start, start + bodyHeight);
      while (visible.length < bodyHeight) visible.push("");

      const frameContent = [
        ...navigationLines,
        theme.fg("border", "─".repeat(innerWidth)),
        headline,
        theme.fg("dim", help),
        ...handoffLines,
        theme.fg("border", "─".repeat(innerWidth)),
        ...visible,
        ...messageLines,
      ];
      let renderedFrame: string[] | undefined;
      if (cachedFrameWidth === innerWidth
        && cachedFrameContent
        && cachedFrameContent.length === frameContent.length
        && cachedFrameLines) {
        let changedCount = 0;
        let changed0 = -1;
        let changed1 = -1;
        let changed2 = -1;
        let changed3 = -1;
        for (let index = 0; index < frameContent.length; index++) {
          if (frameContent[index] === cachedFrameContent[index]) continue;
          if (changedCount === 0) changed0 = index;
          else if (changedCount === 1) changed1 = index;
          else if (changedCount === 2) changed2 = index;
          else if (changedCount === 3) changed3 = index;
          changedCount++;
          if (changedCount > 4) break;
        }
        if (changedCount === 0) {
          fastFrameKey = currentFastFrameKey;
          fastFrameMessages = currentMessages;
          fastFrameMessageCount = currentMessages.length;
          fastFrameLastMessage = lastMessage;
          return cachedFrameLines.slice();
        }
        if (changedCount <= 4) {
          const renderFrameRow = cachedFrameRowRenderer!;
          renderedFrame = cachedFrameLines.slice();
          renderedFrame[changed0 + 1] = renderFrameRow(frameContent[changed0]);
          if (changedCount > 1) {
            renderedFrame[changed1 + 1] = renderFrameRow(frameContent[changed1]);
            if (changedCount > 2) {
              renderedFrame[changed2 + 1] = renderFrameRow(frameContent[changed2]);
              if (changedCount > 3) renderedFrame[changed3 + 1] = renderFrameRow(frameContent[changed3]);
            }
          }
        }
      }
      if (!renderedFrame) {
        renderedFrame = framePanel(frameContent, innerWidth, frameStyle);
        cachedFrameRowRenderer = createFramePanelRowRenderer(innerWidth, frameStyle);
      }
      cachedFrameWidth = innerWidth;
      cachedFrameContent = frameContent;
      cachedFrameLines = renderedFrame;
      fastFrameKey = currentFastFrameKey;
      fastFrameMessages = currentMessages;
      fastFrameMessageCount = currentMessages.length;
      fastFrameLastMessage = lastMessage;
      return renderedFrame;
    },
    invalidate() {
      messageInput.invalidate();
      transcriptAgent = undefined;
      transcriptMessages = undefined;
      transcriptMessageCount = -1;
      transcriptLastMessage = undefined;
      transcriptWidth = -1;
      cachedTranscriptLines = [];
      cachedFrameWidth = -1;
      cachedFrameRowRenderer = undefined;
      cachedFrameContent = null;
      cachedFrameLines = null;
      fastFrameKey = "";
      fastFrameMessages = undefined;
      fastFrameMessageCount = -1;
      fastFrameLastMessage = undefined;
    },
    dispose() {
      clearInterval(refreshTimer);
      if (forwardHerdrPageKeys) tui.terminal.write("\x1b[?1000l");
    },
    handleInput(data: string) {
      if (composingMessage) {
        if (matchesKey(data, Key.ctrl("c"))) {
          done();
          return;
        }
        messageInput.handleInput(data);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done();
        return;
      }
      if (matchesKey(data, Key.up)) {
        selectPreviousOrMain();
        return;
      }
      if (data.toLowerCase() === "l") {
        expandLargeToolResults = !expandLargeToolResults;
        offsetFromBottom = 0;
        tui.requestRender();
        return;
      }
      if (data.toLowerCase() === "m" && options.sendMessage) {
        composingMessage = true;
        messageStatus = "";
        syncInputFocus();
        tui.requestRender();
        return;
      }
      if (data.toLowerCase() === "i" && options.interruptAgent) {
        const agent = currentAgent(sortedAgents(), selectedName);
        if (!agent || interruptingAgents.has(agent.name)) return;
        interruptingAgents.add(agent.name);
        tui.requestRender();
        void Promise.resolve()
          .then(() => options.interruptAgent?.(agent.name))
          .catch(() => {})
          .finally(() => {
            interruptingAgents.delete(agent.name);
            tui.requestRender();
          });
        return;
      }
      if (data.toLowerCase() === "h" && options.handoffAgent) {
        const agent = currentAgent(sortedAgents(), selectedName);
        if (!agent || !canHandoff(agent)) return;
        handoffAgents.add(agent.name);
        handoffStatus = "";
        tui.requestRender();
        void Promise.resolve()
          .then(() => options.handoffAgent?.(agent.name))
          .then(() => done())
          .catch((error: unknown) => {
            handoffStatus = error instanceof Error ? error.message : `Could not move ${agent.name} to Herdr.`;
          })
          .finally(() => {
            handoffAgents.delete(agent.name);
            tui.requestRender();
          });
        return;
      }
      if (data.toLowerCase() === "x" && options.stopAgent) {
        const agent = currentAgent(sortedAgents(), selectedName);
        if (!agent || stoppingAgents.has(agent.name)) return;
        stoppingAgents.add(agent.name);
        tui.requestRender();
        try {
          const result = options.stopAgent(agent.name);
          if (result && typeof result.then === "function") {
            void result.finally(() => {
              stoppingAgents.delete(agent.name);
              tui.requestRender();
            });
          } else {
            stoppingAgents.delete(agent.name);
            tui.requestRender();
          }
        } catch {
          stoppingAgents.delete(agent.name);
          tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, Key.left)) {
        selectRelative(-1);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
        selectRelative(1);
        tui.requestRender();
        return;
      }
      const maxOffset = Math.max(0, lastTranscriptRows - lastBodyHeight);
      if (matchesKey(data, Key.pageUp)) offsetFromBottom = Math.min(maxOffset, offsetFromBottom + lastBodyHeight);
      else if (matchesKey(data, Key.pageDown)) offsetFromBottom = Math.max(0, offsetFromBottom - lastBodyHeight);
      else if (matchesKey(data, Key.home)) offsetFromBottom = maxOffset;
      else if (matchesKey(data, Key.end)) offsetFromBottom = 0;
      else return;
      tui.requestRender();
    },
  };
}

export async function openAgentFollowView(ctx: any, options: AgentFollowViewOptions): Promise<void> {
  if (ctx.mode && ctx.mode !== "tui") return;
  await ctx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: () => void) => createAgentFollowComponent(tui, done, options, theme),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "center",
        margin: 0,
      },
    }
  );
}
