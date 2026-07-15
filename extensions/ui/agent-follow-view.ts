import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { RunningReadAgent } from "../runtime/types";
import { dimAnsi, pink, purple } from "./ansi";
import { framePanel } from "./frame";
import { extractTextParts, formatAnimatedProgress, formatElapsed, formatModelLabel, formatTokenCount, sanitizePlainTuiLine, sanitizeTuiLine, sanitizeTuiText } from "./renderers";

const REFRESH_INTERVAL_MS = 250;
const MAX_NAVIGATION_AGENTS = 6;
const AGENT_FOLLOW_BACKGROUND = "\x1b[48;2;22;23;32m";
const PROGRESS_BAND_BACKGROUND = "\x1b[48;2;31;33;47m";
const PROGRESS_RULE_FOREGROUND = "\x1b[38;2;75;79;103m";
const ACTION_FOREGROUND = "\x1b[38;5;117m";
const PATH_FOREGROUND = "\x1b[38;5;213m";
const SUCCESS_FOREGROUND = "\x1b[38;5;114m";
const FAILURE_FOREGROUND = "\x1b[38;5;210m";
const PENDING_FOREGROUND = "\x1b[38;5;222m";
const BODY_FOREGROUND = "\x1b[38;5;253m";
const MUTED_FOREGROUND = "\x1b[38;5;247m";
const STRUCTURAL_FOREGROUND = "\x1b[38;5;141m";
const ANSI_FOREGROUND_RESET = "\x1b[39m";
const ANSI_RESET = "\x1b[0m";
const COLLAPSED_TOOL_RESULT_LINE_LIMIT = 14;
const COLLAPSED_TOOL_RESULT_HEAD_LINES = 8;
const COLLAPSED_TOOL_RESULT_TAIL_LINES = 3;

export interface AgentFollowViewOptions {
  getAgents(): RunningReadAgent[];
  initialAgentName?: string;
  stopAgent?(name: string): void | Promise<void>;
  sendMessage?(name: string, content: string): void | Promise<void>;
}

export interface AgentFollowTranscriptOptions {
  expandLargeToolResults?: boolean;
  width?: number;
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

function semanticAnsi(text: string, foreground: string): string {
  return `${foreground}${text}${ANSI_FOREGROUND_RESET}`;
}

function actionAnsi(text: string): string {
  return semanticAnsi(text, ACTION_FOREGROUND);
}

function pathAnsi(text: string): string {
  return semanticAnsi(text, PATH_FOREGROUND);
}

function successAnsi(text: string): string {
  return semanticAnsi(text, SUCCESS_FOREGROUND);
}

function failureAnsi(text: string): string {
  return semanticAnsi(text, FAILURE_FOREGROUND);
}

function pendingAnsi(text: string): string {
  return semanticAnsi(text, PENDING_FOREGROUND);
}

function bodyAnsi(text: string): string {
  return semanticAnsi(text, BODY_FOREGROUND);
}

function mutedAnsi(text: string): string {
  return semanticAnsi(text, MUTED_FOREGROUND);
}

function structuralAnsi(text: string): string {
  return semanticAnsi(text, STRUCTURAL_FOREGROUND);
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

function renderState(state: string): string {
  if (state === "failed") return failureAnsi(state);
  if (state === "working" || state === "submitting") return pendingAnsi(state);
  if (state === "duplicate") return mutedAnsi(state);
  return successAnsi(state);
}

function renderActionPathState(action: string, path: string, state: string, width?: number): string {
  return boundTranscriptLine(
    `${actionAnsi(action)}${mutedAnsi(" · ")}${pathAnsi(path)}${mutedAnsi(" · ")}${renderState(state)}`,
    width,
  );
}

function progressBandLine(content: string, width: number): string {
  const bounded = truncateToWidth(content, width, "…", true);
  const reassertedBackground = bounded.split(ANSI_RESET).join(`${ANSI_RESET}${PROGRESS_BAND_BACKGROUND}`);
  return `${PROGRESS_BAND_BACKGROUND}${reassertedBackground}${ANSI_RESET}`;
}

function renderProgressBlock(status: string, failed: boolean, width?: number): string[] {
  const content = ` ${actionAnsi("progress")}${mutedAnsi(" · ")}${bodyAnsi(status)}${failed ? `${mutedAnsi(" · ")}${failureAnsi("failed")}` : ""}`;
  const bandWidth = Math.max(1, width ?? visibleWidth(content));
  const rule = `${PROGRESS_BAND_BACKGROUND}${PROGRESS_RULE_FOREGROUND}${"─".repeat(bandWidth)}${ANSI_FOREGROUND_RESET}${ANSI_RESET}`;
  const bottomPadding = `${PROGRESS_BAND_BACKGROUND}${" ".repeat(bandWidth)}${ANSI_RESET}`;
  return [rule, progressBandLine(content, bandWidth), bottomPadding];
}

function renderCompactToolBlock(block: Extract<TranscriptBlock, { kind: "tool" }>, width?: number): string[] | undefined {
  if (block.name === "report_progress") {
    const details = asRecord(block.details);
    const args = asRecord(block.args);
    const resultStatus = block.result?.replace(/^Progress updated:\s*/i, "");
    const rawStatus = details?.status ?? args?.status ?? resultStatus ?? (block.isError ? "failed" : "working");
    const status = compactTranscriptLine(String(rawStatus)) || (block.isError ? "failed" : "working");
    return renderProgressBlock(status, block.isError === true, width);
  }

  if (block.name === "edit") {
    const path = toolPath(block.args);
    if (block.result === undefined) return [renderActionPathState("edit", path, "working", width)];
    if (block.isError) return [renderActionPathState("edit", path, "failed", width)];
    const counts = editDiffCounts(block.details);
    const added = counts ? `+${counts.added}` : "+?";
    const removed = counts ? `−${counts.removed}` : "−?";
    return [boundTranscriptLine(
      `${actionAnsi("edit")}${mutedAnsi(" · ")}${pathAnsi(path)}${mutedAnsi(" · ")}${successAnsi(added)} ${failureAnsi(removed)}${mutedAnsi(" · ")}${successAnsi("worked")}`,
      width,
    )];
  }

  if (block.name === "write") {
    const state = block.result === undefined ? "working" : block.isError ? "failed" : "worked";
    return [renderActionPathState("write", toolPath(block.args), state, width)];
  }

  if (block.name === "claim_file" || block.name === "release_file") {
    const details = asRecord(block.details);
    const conflicts = Array.isArray(details?.conflicts) ? details.conflicts : [];
    const state = block.result === undefined
      ? "working"
      : block.isError || conflicts.length > 0
        ? "failed"
        : "worked";
    const action = block.name === "claim_file" ? "claim" : "release";
    return [renderActionPathState(action, toolPaths(block.args), state, width)];
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
    return [boundTranscriptLine(`${actionAnsi("final report")}${mutedAnsi(" · ")}${renderState(state)}`, width)];
  }

  return undefined;
}

function renderToolHeader(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
  const detail = compactToolArgs(block.name, block.args);
  if (!detail) return `${structuralAnsi("╭─")} ${actionAnsi(block.name)}`;
  const isPath = typeof asRecord(block.args)?.path === "string";
  const renderedDetail = isPath ? pathAnsi(detail) : bodyAnsi(`${block.name === "bash" ? "$ " : ""}${detail}`);
  return `${structuralAnsi("╭─")} ${actionAnsi(block.name)}${mutedAnsi(" · ")}${renderedDetail}`;
}

function renderToolBlock(block: Extract<TranscriptBlock, { kind: "tool" }>, expandLargeToolResults: boolean, width?: number): string[] {
  const compactBlock = renderCompactToolBlock(block, width);
  if (compactBlock) return compactBlock;

  const header = renderToolHeader(block);
  if (block.result === undefined) {
    return [header, `${structuralAnsi("│")} ${pendingAnsi("waiting for result…")}`, `${structuralAnsi("╰─")} ${pendingAnsi("running")}`, ""];
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
    ? `${structuralAnsi("│")} ${mutedAnsi(line)}`
    : `${structuralAnsi("│")} ${line}`);
  const summary = `${resultLines.length} line${resultLines.length === 1 ? "" : "s"} · ${formatResultSize(result)}${isCollapsed ? " · collapsed" : ""}`;
  const renderedSummary = block.isError ? failureAnsi(summary) : successAnsi(summary);
  return [header, ...body, `${structuralAnsi("╰─")} ${renderedSummary}`, ""];
}

export function formatAgentFollowTranscript(messages: any[], options: AgentFollowTranscriptOptions = {}): string[] {
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

  const lines = blocks.flatMap(block => block.kind === "section"
    ? [block.label === "user" ? pink(block.label) : purple(block.label), block.text, ""]
    : renderToolBlock(block, options.expandLargeToolResults === true, options.width));
  return lines.length > 0 ? lines : [dimAnsi("Waiting for the agent's first transcript event…")];
}

function currentAgent(agents: RunningReadAgent[], selectedName: string | undefined): RunningReadAgent | undefined {
  return agents.find(agent => agent.name === selectedName) ?? agents[0];
}

export function createAgentFollowComponent(
  tui: any,
  done: () => void,
  options: AgentFollowViewOptions
) {
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
  const stoppingAgents = new Set<string>();
  const refreshTimer = setInterval(() => tui.requestRender(), REFRESH_INTERVAL_MS);

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
          pink("agent navigation"),
          purple("↑  main agent"),
          dimAnsi("No active agents. Press ↑ or esc to return to main."),
          ...Array.from({ length: emptyBodyHeight }, () => ""),
        ], innerWidth, AGENT_FOLLOW_BACKGROUND);
      }

      const selectedIndex = Math.max(0, agents.findIndex(item => item.name === agent.name));
      const navigationStart = Math.max(0, Math.min(selectedIndex - 2, agents.length - MAX_NAVIGATION_AGENTS));
      const visibleAgents = agents.slice(navigationStart, navigationStart + MAX_NAVIGATION_AGENTS);
      const navigationLines = [pink("agent navigation"), purple("↑  main agent")];
      if (navigationStart > 0) navigationLines.push(dimAnsi(`   … ${navigationStart} agent${navigationStart === 1 ? "" : "s"} above`));
      for (const item of visibleAgents) {
        const selected = item.name === agent.name;
        navigationLines.push(`${selected ? pink("->") : "  "} ${item.name}`);
      }
      const remainingAgents = agents.length - navigationStart - visibleAgents.length;
      if (remainingAgents > 0) navigationLines.push(dimAnsi(`↓  … ${remainingAgents} more agent${remainingAgents === 1 ? "" : "s"}`));

      const messageLines = options.sendMessage ? [
        purple("─".repeat(innerWidth)),
        composingMessage ? pink(`message ${agent.name}`) : dimAnsi(`message ${agent.name}`),
        ...(composingMessage ? messageInput.render(innerWidth) : [dimAnsi("> Press m to start typing")]),
        messageStatus
          ? dimAnsi(messageStatus)
          : dimAnsi(composingMessage ? "enter send · esc cancel" : "m message selected agent"),
      ] : [];
      const bodyHeight = Math.max(4, terminalRows - navigationLines.length - 6 - messageLines.length);
      lastBodyHeight = bodyHeight;

      selectedName = agent.name;
      try {
        const total = agent.session?.getSessionStats().tokens.total;
        if (typeof total === "number") agent.tokensUsed = total;
      } catch {
        // The nested session may be shutting down while this view renders.
      }

      const renderNow = Date.now();
      const model = formatModelLabel(agent.model, agent.thinking).replace(" · ", "/");
      const slot = agent.modelSlot || "level inherited";
      const elapsed = formatElapsed(renderNow - agent.startedAt);
      const progress = stoppingAgents.has(agent.name) ? "stopping" : (agent.latestProgress || agent.status);
      const animatedProgress = formatAnimatedProgress(progress, renderNow);
      const headline = `(${agent.name}) ${model} · ${slot} · ${elapsed} · ${formatTokenCount(agent.tokensUsed)} tok · ${animatedProgress}`;
      const logAction = expandLargeToolResults ? "l collapse logs" : "l expand logs";
      const messageAction = options.sendMessage ? " · m message" : "";
      const help = composingMessage
        ? `message ${agent.name} · enter send · esc cancel`
        : agents.length > 1
          ? `↑ previous/main · ↓ next agent · ←/→ agent · ${logAction}${messageAction} · x stop · pgup/pgdn scroll · esc main`
          : `↑/esc main · ${logAction}${messageAction} · x stop · pgup/pgdn scroll · end follow`;

      const transcriptWidth = Math.max(20, innerWidth);
      const transcriptLines = formatAgentFollowTranscript(agent.session?.messages || [], {
        expandLargeToolResults,
        width: transcriptWidth,
      }).flatMap(line => wrapTextWithAnsi(line, transcriptWidth));
      lastTranscriptRows = transcriptLines.length;
      const maxOffset = Math.max(0, transcriptLines.length - bodyHeight);
      offsetFromBottom = Math.min(offsetFromBottom, maxOffset);
      const start = Math.max(0, maxOffset - offsetFromBottom);
      const visible = transcriptLines.slice(start, start + bodyHeight);
      while (visible.length < bodyHeight) visible.push("");

      return framePanel([
        ...navigationLines,
        purple("─".repeat(innerWidth)),
        truncateToWidth(headline, innerWidth, "…", true),
        dimAnsi(help),
        purple("─".repeat(innerWidth)),
        ...visible,
        ...messageLines,
      ], innerWidth, AGENT_FOLLOW_BACKGROUND);
    },
    invalidate() {
      messageInput.invalidate();
    },
    dispose() {
      clearInterval(refreshTimer);
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
    (tui: any, _theme: any, _keybindings: any, done: () => void) => createAgentFollowComponent(tui, done, options),
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
