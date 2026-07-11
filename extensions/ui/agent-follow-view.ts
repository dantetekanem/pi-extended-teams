import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { RunningReadAgent } from "../runtime/types";
import { dimAnsi, pink, purple } from "./ansi";
import { framePanel } from "./frame";
import { extractTextParts, formatAnimatedProgress, formatElapsed, formatModelLabel, formatTokenCount, sanitizeTuiLine, sanitizeTuiText } from "./renderers";

const REFRESH_INTERVAL_MS = 250;
const MAX_NAVIGATION_AGENTS = 6;

export interface AgentFollowViewOptions {
  getAgents(): RunningReadAgent[];
  initialAgentName?: string;
  stopAgent?(name: string): void | Promise<void>;
}

function stringifyToolArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function formatAgentFollowTranscript(messages: any[]): string[] {
  const lines: string[] = [];

  for (const message of messages || []) {
    if (message?.role === "user") {
      const text = sanitizeTuiText(extractTextParts(message.content));
      if (text) lines.push(pink("user"), text, "");
      continue;
    }

    if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
          lines.push(purple("thinking"), sanitizeTuiText(part.thinking.trim()), "");
        } else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          lines.push(purple("assistant"), sanitizeTuiText(part.text.trim()), "");
        } else if (part?.type === "toolCall") {
          lines.push(purple(`tool ${sanitizeTuiLine(String(part.name || "unknown"))}`));
          const args = sanitizeTuiText(stringifyToolArgs(part.arguments ?? part.args));
          if (args) lines.push(args);
          lines.push("");
        }
      }
      continue;
    }

    if (message?.role === "toolResult") {
      lines.push(purple(`result ${sanitizeTuiLine(String(message.toolName || "tool"))}`));
      const text = sanitizeTuiText(extractTextParts(message.content));
      lines.push(text || dimAnsi("(no output)"), "");
    }
  }

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
  const stoppingAgents = new Set<string>();
  const refreshTimer = setInterval(() => tui.requestRender(), REFRESH_INTERVAL_MS);

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
        ], innerWidth);
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

      const bodyHeight = Math.max(4, terminalRows - navigationLines.length - 6);
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
      const help = agents.length > 1
        ? "↑ previous/main · ↓ next agent · ←/→ agent · x stop · pgup/pgdn scroll · esc main"
        : "↑/esc main · x stop · pgup/pgdn scroll · end follow";

      const transcriptWidth = Math.max(20, innerWidth);
      const transcriptLines = formatAgentFollowTranscript(agent.session?.messages || [])
        .flatMap(line => wrapTextWithAnsi(line, transcriptWidth));
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
      ], innerWidth);
    },
    invalidate() {},
    dispose() {
      clearInterval(refreshTimer);
    },
    handleInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done();
        return;
      }
      if (matchesKey(data, Key.up)) {
        selectPreviousOrMain();
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
